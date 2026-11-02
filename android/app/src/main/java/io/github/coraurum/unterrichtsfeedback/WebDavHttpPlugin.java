package io.github.coraurum.unterrichtsfeedback;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.IOException;
import java.util.Iterator;
import java.util.concurrent.TimeUnit;

import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.ResponseBody;

/**
 * WebDAV-Anfragen aus der App direkt über Android statt über die WebView. So gilt keine CORS-Sperre, und
 * WebDAV-Methoden wie PROPFIND und MKCOL sind möglich (die eingebaute HTTP-Klasse von Java kennt sie nicht).
 */
@CapacitorPlugin(name = "WebDavHttp")
public class WebDavHttpPlugin extends Plugin {

    private final OkHttpClient client = new OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .writeTimeout(60, TimeUnit.SECONDS)
        .build();

    @PluginMethod
    public void request(PluginCall call) {
        String method = call.getString("method", "GET");
        String url = call.getString("url");
        String body = call.getString("body");
        JSObject headers = call.getObject("headers", new JSObject());

        Request.Builder request = new Request.Builder().url(url);
        String contentType = null;
        for (Iterator<String> keys = headers.keys(); keys.hasNext(); ) {
            String key = keys.next();
            String value = headers.getString(key);
            if (value == null) continue;
            if ("content-type".equalsIgnoreCase(key)) contentType = value;
            request.header(key, value);
        }
        RequestBody requestBody = body == null
            ? (requiresBody(method) ? RequestBody.create(new byte[0], null) : null)
            : RequestBody.create(body, contentType == null ? null : MediaType.parse(contentType));
        request.method(method, requestBody);

        try (Response response = client.newCall(request.build()).execute()) {
            ResponseBody responseBody = response.body();
            JSObject result = new JSObject();
            result.put("status", response.code());
            result.put("body", responseBody == null ? "" : responseBody.string());
            call.resolve(result);
        } catch (IOException | IllegalArgumentException e) {
            call.reject("network: " + e.getMessage());
        }
    }

    /** OkHttp verlangt für diese Methoden einen (ggf. leeren) Inhalt. */
    private static boolean requiresBody(String method) {
        return "PUT".equals(method) || "POST".equals(method) || "PROPFIND".equals(method) || "PATCH".equals(method);
    }
}
