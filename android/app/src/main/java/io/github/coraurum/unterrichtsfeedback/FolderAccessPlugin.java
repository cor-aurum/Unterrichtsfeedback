package io.github.coraurum.unterrichtsfeedback;

import android.content.Intent;
import android.content.UriPermission;
import android.net.Uri;

import androidx.activity.result.ActivityResult;
import androidx.documentfile.provider.DocumentFile;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/**
 * Zugriff auf einen Ordner, den die Nutzerin oder der Nutzer über die Android-Dateiauswahl freigibt
 * (Storage Access Framework), z. B. einen Ordner der Nextcloud-App. Die Freigabe bleibt über Neustarts erhalten.
 */
@CapacitorPlugin(name = "FolderAccess")
public class FolderAccessPlugin extends Plugin {

    private static final int ACCESS_FLAGS =
        Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION;

    @PluginMethod
    public void pickFolder(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(ACCESS_FLAGS | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        startActivityForResult(call, intent, "folderPicked");
    }

    @ActivityCallback
    private void folderPicked(PluginCall call, ActivityResult result) {
        Intent data = result.getData();
        if (data == null || data.getData() == null) {
            call.reject("cancelled");
            return;
        }
        Uri uri = data.getData();
        getContext().getContentResolver().takePersistableUriPermission(uri, ACCESS_FLAGS);
        DocumentFile folder = DocumentFile.fromTreeUri(getContext(), uri);
        JSObject response = new JSObject();
        response.put("uri", uri.toString());
        response.put("name", folder != null && folder.getName() != null ? folder.getName() : "Ordner");
        call.resolve(response);
    }

    @PluginMethod
    public void hasAccess(PluginCall call) {
        String uri = call.getString("uri");
        boolean granted = false;
        for (UriPermission permission : getContext().getContentResolver().getPersistedUriPermissions()) {
            if (permission.getUri().toString().equals(uri) && permission.isReadPermission() && permission.isWritePermission()) {
                granted = true;
            }
        }
        JSObject response = new JSObject();
        response.put("granted", granted);
        call.resolve(response);
    }

    @PluginMethod
    public void list(PluginCall call) {
        DocumentFile folder = folder(call);
        if (folder == null) return;
        JSArray names = new JSArray();
        for (DocumentFile file : folder.listFiles()) {
            if (file.isFile() && file.getName() != null) names.put(file.getName());
        }
        JSObject response = new JSObject();
        response.put("names", names);
        call.resolve(response);
    }

    @PluginMethod
    public void read(PluginCall call) {
        DocumentFile file = existingFile(call);
        if (file == null) return;
        try (InputStream in = getContext().getContentResolver().openInputStream(file.getUri())) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int read;
            while ((read = in.read(buffer)) != -1) out.write(buffer, 0, read);
            JSObject response = new JSObject();
            response.put("text", out.toString(StandardCharsets.UTF_8.name()));
            call.resolve(response);
        } catch (IOException | NullPointerException e) {
            call.reject("Datei konnte nicht gelesen werden: " + e.getMessage());
        }
    }

    @PluginMethod
    public void write(PluginCall call) {
        DocumentFile folder = folder(call);
        if (folder == null) return;
        String name = call.getString("name");
        String text = call.getString("text", "");
        DocumentFile file = folder.findFile(name);
        if (file == null) file = folder.createFile("application/json", name);
        if (file == null) {
            call.reject("Datei „" + name + "“ konnte nicht angelegt werden.");
            return;
        }
        // "wt" kürzt die Datei vorher; nicht jeder Anbieter kennt den Modus.
        try (OutputStream out = openForWriting(file.getUri())) {
            out.write(text.getBytes(StandardCharsets.UTF_8));
            call.resolve();
        } catch (IOException | NullPointerException e) {
            call.reject("Datei „" + name + "“ konnte nicht geschrieben werden: " + e.getMessage());
        }
    }

    @PluginMethod
    public void remove(PluginCall call) {
        DocumentFile file = existingFile(call);
        if (file == null) return;
        if (file.delete()) {
            call.resolve();
        } else {
            call.reject("Datei konnte nicht gelöscht werden.");
        }
    }

    private OutputStream openForWriting(Uri uri) throws IOException {
        try {
            return getContext().getContentResolver().openOutputStream(uri, "wt");
        } catch (IllegalArgumentException | UnsupportedOperationException e) {
            return getContext().getContentResolver().openOutputStream(uri, "w");
        }
    }

    private DocumentFile folder(PluginCall call) {
        String uri = call.getString("uri");
        DocumentFile folder = uri == null ? null : DocumentFile.fromTreeUri(getContext(), Uri.parse(uri));
        if (folder == null || !folder.canWrite()) {
            call.reject("Kein Zugriff auf den Ordner. Bitte erneut auswählen.");
            return null;
        }
        return folder;
    }

    private DocumentFile existingFile(PluginCall call) {
        DocumentFile folder = folder(call);
        if (folder == null) return null;
        DocumentFile file = folder.findFile(call.getString("name", ""));
        if (file == null) call.reject("Datei nicht gefunden.");
        return file;
    }
}
