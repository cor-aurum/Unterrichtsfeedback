package io.github.coraurum.unterrichtsfeedback;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Eigene Plugins müssen vor super.onCreate registriert werden.
        registerPlugin(FolderAccessPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
