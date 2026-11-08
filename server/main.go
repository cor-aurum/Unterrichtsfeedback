// unterricht-feedback-server: Server für die App Unterrichtsfeedback. Er speichert die Daten aller Lehrer, regelt,
// wer welche Personen sehen darf, und ersetzt die frühere Ordner-Synchronisation.
//
//	unterricht-feedback-server serve       --db daten.db --public-url https://feedback.example.de
//	unterricht-feedback-server invite      --db daten.db --public-url https://feedback.example.de
//	unterricht-feedback-server reset-code  --db daten.db --public-url https://feedback.example.de --user anna
//	unterricht-feedback-server accounts    --db daten.db
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/cor-aurum/Unterrichtsfeedback/server/internal/api"
	"github.com/cor-aurum/Unterrichtsfeedback/server/internal/store"
)

// version setzt der Build (GitHub Actions) über -ldflags.
var version = "dev"

const usage = `unterricht-feedback-server %s

Befehle:
  serve       Server starten
  invite      Einladungscode für einen neuen Lehrer erzeugen (z. B. den ersten)
  reset-code  Code erzeugen, mit dem ein Lehrer ein neues Passwort vergibt
  accounts    Konten auflisten
  version     Version anzeigen

Optionen je Befehl mit „<befehl> -h“. Umgebungsvariablen statt Optionen:
  UF_DB, UF_LISTEN, UF_PUBLIC_URL, UF_ALLOW_ORIGIN
`

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintf(os.Stderr, usage, version)
		os.Exit(2)
	}
	command, args := os.Args[1], os.Args[2:]
	var err error
	switch command {
	case "serve":
		err = serve(args)
	case "invite":
		err = invite(args)
	case "reset-code":
		err = resetCode(args)
	case "accounts":
		err = accounts(args)
	case "version", "--version", "-v":
		fmt.Println(version)
	case "help", "-h", "--help":
		fmt.Printf(usage, version)
	default:
		fmt.Fprintf(os.Stderr, "Unbekannter Befehl „%s“.\n\n"+usage, command, version)
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "Fehler:", err)
		os.Exit(1)
	}
}

// options sind die gemeinsamen Einstellungen; jede lässt sich auch über eine Umgebungsvariable setzen.
type options struct {
	db, listen, publicURL, origin string
}

func flags(name string, args []string, extra func(*flag.FlagSet)) (*options, error) {
	o := &options{}
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	fs.StringVar(&o.db, "db", env("UF_DB", "unterricht-feedback.db"), "SQLite-Datei mit allen Daten")
	fs.StringVar(&o.listen, "listen", env("UF_LISTEN", "127.0.0.1:8080"), "Adresse und Port (nur HTTP, HTTPS macht der Reverse-Proxy)")
	fs.StringVar(&o.publicURL, "public-url", env("UF_PUBLIC_URL", ""), "Adresse, unter der die App den Server erreicht, z. B. https://feedback.example.de")
	fs.StringVar(&o.origin, "allow-origin", env("UF_ALLOW_ORIGIN", "*"), "erlaubter Ursprung für Browser-Zugriffe (CORS), z. B. https://name.github.io")
	if extra != nil {
		extra(fs)
	}
	return o, fs.Parse(args)
}

func env(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func (o *options) open() (*store.Store, *api.Server, error) {
	st, err := store.Open(o.db)
	if err != nil {
		return nil, nil, err
	}
	return st, api.New(st, o.publicURL, o.origin), nil
}

func serve(args []string) error {
	o, err := flags("serve", args, nil)
	if err != nil {
		return err
	}
	st, server, err := o.open()
	if err != nil {
		return err
	}
	defer st.Close()
	if err := server.Migrate(context.Background()); err != nil {
		return fmt.Errorf("Daten umstellen: %w", err)
	}
	if o.publicURL == "" {
		log.Print("Hinweis: --public-url fehlt; Einladungscodes aus der App enthalten dann keine Serveradresse.")
	}

	httpServer := &http.Server{
		Addr:              o.listen,
		Handler:           server.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       2 * time.Minute,
		WriteTimeout:      2 * time.Minute,
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go cleanup(ctx, st)
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(shutdown)
	}()
	log.Printf("unterricht-feedback-server %s lauscht auf %s (Daten: %s)", version, o.listen, o.db)
	if err := httpServer.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

// cleanup löscht stündlich abgelaufene Codes und alte Anmeldungen.
func cleanup(ctx context.Context, st *store.Store) {
	ticker := time.NewTicker(time.Hour)
	defer ticker.Stop()
	for {
		if err := st.DeleteExpired(ctx, api.MaxIdle); err != nil && ctx.Err() == nil {
			log.Printf("Aufräumen: %v", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// invite erzeugt einen Einladungscode, der an keinen Lehrer gebunden ist: Beim Einlösen gilt der Lehrer der App,
// damit z. B. vorhandene Daten des ersten Lehrers zu seinem Konto passen. Weitere Lehrer laden die Lehrer in der App
// ein; diese Einladungen gehören zu einem bestimmten Lehrer.
func invite(args []string) error {
	o, err := flags("invite", args, nil)
	if err != nil {
		return err
	}
	if o.publicURL == "" {
		return errors.New("--public-url (oder UF_PUBLIC_URL) fehlt; die App braucht die Adresse des Servers im Code")
	}
	st, server, err := o.open()
	if err != nil {
		return err
	}
	defer st.Close()
	code, expires, err := server.NewCode(context.Background(), store.Invite, "")
	if err != nil {
		return err
	}
	fmt.Printf("Einladungscode (gültig bis %s):\n\n%s\n\nIn der App beim ersten Start unter „Mit Server verbinden …“ einfügen.\n",
		expires.Format("02.01.2006 15:04"), code)
	return nil
}

func resetCode(args []string) error {
	var user string
	o, err := flags("reset-code", args, func(fs *flag.FlagSet) {
		fs.StringVar(&user, "user", "", "Benutzername des Lehrers")
	})
	if err != nil {
		return err
	}
	if user == "" {
		return errors.New("--user fehlt (Benutzernamen zeigt „accounts“)")
	}
	if o.publicURL == "" {
		return errors.New("--public-url (oder UF_PUBLIC_URL) fehlt; die App braucht die Adresse des Servers im Code")
	}
	st, server, err := o.open()
	if err != nil {
		return err
	}
	defer st.Close()
	account, err := st.AccountByUsername(context.Background(), user)
	if err != nil {
		return fmt.Errorf("kein Konto „%s“", user)
	}
	code, expires, err := server.NewCode(context.Background(), store.Reset, account.TeacherID)
	if err != nil {
		return err
	}
	fmt.Printf("Reset-Code für %s (gültig bis %s):\n\n%s\n\nIn der App unter „Passwort vergessen?“ einfügen.\n",
		account.Username, expires.Format("02.01.2006 15:04"), code)
	return nil
}

func accounts(args []string) error {
	o, err := flags("accounts", args, nil)
	if err != nil {
		return err
	}
	st, err := store.Open(o.db)
	if err != nil {
		return err
	}
	defer st.Close()
	list, err := st.Accounts(context.Background())
	if err != nil {
		return err
	}
	if len(list) == 0 {
		fmt.Println("Noch keine Konten. Einen ersten Lehrer lädt „invite“ ein.")
		return nil
	}
	for _, a := range list {
		fmt.Printf("%-24s seit %s  (Lehrer-ID %s)\n", a.Username, a.CreatedAt.Format("02.01.2006"), a.TeacherID)
	}
	return nil
}
