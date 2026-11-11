package api

import (
	"sync"

	"github.com/cor-aurum/Unterrichtsfeedback/server/internal/store"
)

// planCache hält je Link die zuletzt gelesenen Pläne. Mit allen PDFs sind sie schnell einige MB groß; tragen sich
// viele Personen gleichzeitig ein, müsste der Server sie sonst bei jedem Aufruf neu lesen. Ob die Fassung noch gilt,
// zeigt der Stand des Links (`updated_at`), der mit jeder neuen Fassung größer wird.
type planCache struct {
	mu      sync.Mutex
	entries map[string]cachedPlans
}

type cachedPlans struct {
	link  store.PlanLink
	plans planContent
}

func newPlanCache() *planCache {
	return &planCache{entries: map[string]cachedPlans{}}
}

// get liefert die Pläne, wenn die gespeicherte Fassung dem Stand `stamp` entspricht.
func (c *planCache) get(stamp store.PlanLink) (planContent, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	entry, ok := c.entries[stamp.Token]
	if !ok || entry.link.PeriodID != stamp.PeriodID || !entry.link.UpdatedAt.Equal(stamp.UpdatedAt) {
		return planContent{}, false
	}
	return entry.plans, true
}

// put merkt sich die Pläne; ältere Links desselben Zeitraums (ersetzt) fallen dabei heraus. Die Pläne werden danach
// nur noch gelesen, nie verändert: Mehrere Anfragen teilen sie sich.
func (c *planCache) put(link store.PlanLink, plans planContent) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for token, entry := range c.entries {
		if entry.link.PeriodID == link.PeriodID && token != link.Token {
			delete(c.entries, token)
		}
	}
	link.Content = nil
	c.entries[link.Token] = cachedPlans{link: link, plans: plans}
}
