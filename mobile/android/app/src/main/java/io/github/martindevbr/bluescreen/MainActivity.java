package io.github.martindevbr.bluescreen;

import android.app.Activity;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.ContentValues;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.graphics.Insets;
import android.net.Uri;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.WindowInsets;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;
import android.window.OnBackInvokedDispatcher;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * O BlueScreen no Android: uma tela de conexão (assets/conectar.html) e, depois de escolher o PC, a própria IDE do
 * PC (http://ip:4748) em tela cheia. Nada da IDE roda no celular: o app guarda os PCs, acha o BlueScreen na rede
 * (anúncio UDP 4749 do share.rs, e uma varredura da sub-rede como reserva) e cuida do que o navegador comum não faz
 * bem: tela cheia com as barras do sistema, voltar, arquivos para enviar e baixar e o link bluescreen://abrir.
 */
public class MainActivity extends Activity {
    static final String CONECTAR = "file:///android_asset/conectar.html";
    static final int FUNDO = 0xFF0F1A2E;
    static final int ESCOLHER_ARQUIVO = 7;
    static final int ANUNCIO = 4749;

    WebView web;
    SharedPreferences prefs;
    /** PC aberto agora ("http://ip:porta"), ou null na tela de conexão */
    volatile String servidor;
    volatile boolean naConexao = true;
    ValueCallback<Uri[]> arquivos;
    long voltouEm;
    final ExecutorService fila = Executors.newCachedThreadPool();

    @Override
    protected void onCreate(Bundle salvo) {
        super.onCreate(salvo);
        prefs = getSharedPreferences("bluescreen", MODE_PRIVATE);
        FrameLayout raiz = new FrameLayout(this);
        raiz.setBackgroundColor(FUNDO);
        web = new WebView(this);
        web.setBackgroundColor(FUNDO);
        raiz.addView(web, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        setContentView(raiz);

        // Android 11+: a página vai até as bordas, e as barras do sistema, o recorte da câmera e o teclado viram
        // margem (no Android 15+ isso é obrigatório; o adjustResize sozinho não encolhe mais a tela com o teclado)
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            raiz.setOnApplyWindowInsetsListener((v, ins) -> {
                Insets i = ins.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
                v.setPadding(i.left, i.top, i.right, i.bottom);
                return WindowInsets.CONSUMED;
            });
        }

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setTextZoom(100); // a fonte grande do sistema não desmonta a IDE (ela tem o próprio zoom)
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setUserAgentString(s.getUserAgentString() + " BlueScreenApp/" + versao());
        CookieManager.getInstance().setAcceptCookie(true);
        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) WebView.setWebContentsDebuggingEnabled(true);
        web.addJavascriptInterface(new Ponte(), "BSApp");
        web.setWebViewClient(new Cliente());
        web.setWebChromeClient(new Chrome());
        web.setDownloadListener(this::baixar);

        if (Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, this::voltar);
        }

        if (!abrirDoLink(getIntent())) {
            // abrir pelo ícone: volta direto para o último PC (se ele não responder, a tela de conexão aparece com o erro)
            String ultimo = prefs.getString("ultimo", null);
            if (ultimo != null) abrir(ultimo); else conectar(null);
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        abrirDoLink(intent);
    }

    /** bluescreen://abrir?url=http://192.168.0.10:4748 */
    boolean abrirDoLink(Intent it) {
        Uri d = it == null ? null : it.getData();
        if (d == null || !"bluescreen".equals(d.getScheme())) return false;
        String u = Enderecos.normalizar(d.getQueryParameter("url"));
        if (u == null) { conectar("O link não tem um endereço de PC válido."); return true; }
        abrir(u);
        return true;
    }

    void abrir(String origem) {
        servidor = origem;
        naConexao = false;
        lembrar(origem, null, null);
        prefs.edit().putString("ultimo", origem).apply();
        web.loadUrl(origem + "/");
    }

    void conectar(String erro) {
        servidor = null;
        naConexao = true;
        web.loadUrl(CONECTAR + (erro == null ? "" : "#erro=" + Uri.encode(erro)));
    }

    // ---------- PCs guardados ----------
    synchronized JSONArray guardados() {
        try { return new JSONArray(prefs.getString("pcs", "[]")); } catch (Exception e) { return new JSONArray(); }
    }

    /** guarda o PC no topo da lista (nome do PC e projeto vêm do anúncio, quando houver) */
    synchronized void lembrar(String url, String nome, String projeto) {
        JSONArray velha = guardados(), nova = new JSONArray();
        try {
            JSONObject atual = new JSONObject().put("url", url).put("em", System.currentTimeMillis());
            for (int i = 0; i < velha.length(); i++) {
                JSONObject o = velha.getJSONObject(i);
                if (url.equals(o.optString("url"))) { atual.put("nome", o.optString("nome", "")); atual.put("projeto", o.optString("projeto", "")); }
            }
            if (nome != null && !nome.isEmpty()) atual.put("nome", nome);
            if (projeto != null) atual.put("projeto", projeto);
            nova.put(atual);
            for (int i = 0; i < velha.length() && nova.length() < 8; i++) {
                JSONObject o = velha.getJSONObject(i);
                if (!url.equals(o.optString("url"))) nova.put(o);
            }
        } catch (Exception ignored) { }
        prefs.edit().putString("pcs", nova.toString()).apply();
    }

    synchronized void esquecer(String url) {
        JSONArray velha = guardados(), nova = new JSONArray();
        for (int i = 0; i < velha.length(); i++) { JSONObject o = velha.optJSONObject(i); if (o != null && !url.equals(o.optString("url"))) nova.put(o); }
        SharedPreferences.Editor e = prefs.edit().putString("pcs", nova.toString());
        if (url.equals(prefs.getString("ultimo", null))) e.remove("ultimo");
        e.apply();
    }

    // ---------- achar o BlueScreen na rede ----------
    /** Escuta o anúncio por UDP e, ao mesmo tempo, testa a porta 4748 em cada IP da sub-rede do Wi-Fi. */
    void procurar() {
        final Set<String> vistos = Collections.synchronizedSet(new HashSet<>());
        fila.execute(() -> {
            ExecutorService sonda = Executors.newFixedThreadPool(48);
            WifiManager.MulticastLock trava = null;
            try {
                WifiManager wm = (WifiManager) getApplicationContext().getSystemService(WIFI_SERVICE);
                if (wm != null) { trava = wm.createMulticastLock("bluescreen"); trava.setReferenceCounted(false); trava.acquire(); }
            } catch (Exception ignored) { }
            for (String ip : sub_redes()) {
                String base = ip.substring(0, ip.lastIndexOf('.') + 1);
                for (int n = 1; n <= 254; n++) {
                    String alvo = base + n;
                    if (alvo.equals(ip)) continue;
                    sonda.execute(() -> testar(alvo, vistos));
                }
            }
            ouvirAnuncio(vistos, 4000);
            sonda.shutdown();
            try { sonda.awaitTermination(8, TimeUnit.SECONDS); } catch (InterruptedException ignored) { }
            if (trava != null) try { trava.release(); } catch (Exception ignored) { }
            js("window.bsFim && bsFim()");
        });
    }

    static java.util.List<String> sub_redes() {
        java.util.List<String> r = new java.util.ArrayList<>();
        try {
            for (NetworkInterface nif : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!nif.isUp() || nif.isLoopback()) continue;
                for (InetAddress a : Collections.list(nif.getInetAddresses())) {
                    if (a instanceof Inet4Address && a.isSiteLocalAddress()) r.add(a.getHostAddress());
                }
            }
        } catch (Exception ignored) { }
        return r;
    }

    void ouvirAnuncio(Set<String> vistos, long ms) {
        try (DatagramSocket sock = new DatagramSocket(null)) {
            sock.setReuseAddress(true);
            sock.setBroadcast(true);
            sock.bind(new InetSocketAddress(ANUNCIO));
            sock.setSoTimeout(400);
            byte[] buf = new byte[8192];
            long fim = System.currentTimeMillis() + ms;
            while (System.currentTimeMillis() < fim) {
                DatagramPacket p = new DatagramPacket(buf, buf.length);
                try { sock.receive(p); } catch (java.net.SocketTimeoutException t) { continue; }
                try {
                    JSONObject o = new JSONObject(new String(p.getData(), 0, p.getLength(), StandardCharsets.UTF_8));
                    if (!"bluescreen".equals(o.optString("bs"))) continue;
                    String url = Enderecos.normalizar(p.getAddress().getHostAddress() + ":" + o.optInt("port", Enderecos.PORTA));
                    if (url != null) achou(url, o.optString("host", ""), o.isNull("project") ? "" : o.optString("project", ""), vistos);
                } catch (Exception ignored) { }
            }
        } catch (Exception ignored) {
            // porta ocupada ou rede sem broadcast: a varredura da sub-rede continua valendo
        }
    }

    void testar(String ip, Set<String> vistos) {
        String url = "http://" + ip + ":" + Enderecos.PORTA;
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url + "/api/session").openConnection();
            c.setConnectTimeout(450);
            c.setReadTimeout(1200);
            c.setUseCaches(false);
            if (c.getResponseCode() != 200) return;
            try (InputStream in = c.getInputStream()) {
                byte[] b = new byte[512];
                int n = in.read(b);
                // o BlueScreen da rede responde {"remote":true,"authed":...}
                if (n > 0 && new String(b, 0, n, StandardCharsets.UTF_8).contains("\"remote\":true")) achou(url, "", null, vistos);
            }
        } catch (Exception ignored) {
        } finally { if (c != null) c.disconnect(); }
    }

    void achou(String url, String nome, String projeto, Set<String> vistos) {
        boolean novo = vistos.add(url);
        // o anúncio chega depois da varredura com o nome do PC: manda de novo, com o nome
        if (!novo && (nome == null || nome.isEmpty())) return;
        try {
            JSONObject o = new JSONObject().put("url", url).put("nome", nome == null ? "" : nome).put("projeto", projeto == null ? "" : projeto);
            if (nome != null && !nome.isEmpty()) lembrarNome(url, nome, projeto);
            js("window.bsAchou && bsAchou(" + o + ")");
        } catch (Exception ignored) { }
    }

    /** atualiza o nome de um PC que já está na lista (sem colocar na lista quem nunca foi aberto) */
    synchronized void lembrarNome(String url, String nome, String projeto) {
        JSONArray l = guardados();
        boolean mudou = false;
        for (int i = 0; i < l.length(); i++) {
            JSONObject o = l.optJSONObject(i);
            if (o != null && url.equals(o.optString("url"))) {
                try { o.put("nome", nome); if (projeto != null) o.put("projeto", projeto); mudou = true; } catch (Exception ignored) { }
            }
        }
        if (mudou) prefs.edit().putString("pcs", l.toString()).apply();
    }

    void js(String codigo) { runOnUiThread(() -> { if (naConexao) web.evaluateJavascript(codigo, null); }); }

    // ---------- ponte com a página (window.BSApp) ----------
    /** Só a tela de conexão (do próprio app) usa a lista e a conexão; a IDE do PC só pode salvar um arquivo baixado. */
    class Ponte {
        @JavascriptInterface public String pcs() { return naConexao ? guardados().toString() : "[]"; }
        @JavascriptInterface public String versao() { return MainActivity.this.versao(); }
        @JavascriptInterface public void procurar() { if (naConexao) MainActivity.this.procurar(); }
        @JavascriptInterface public void esquecer(String url) { if (naConexao && url != null) MainActivity.this.esquecer(url); }
        /** "" se abriu, ou a mensagem do erro */
        @JavascriptInterface public String conectar(String endereco) {
            if (!naConexao) return "";
            String u = Enderecos.normalizar(endereco);
            if (u == null) return "Digite o IP do PC, como 192.168.0.10 (com :porta, se mudou a 4748).";
            runOnUiThread(() -> abrir(u));
            return "";
        }
        /** arquivo que a página gerou na hora (blob: ou data:), em base64 */
        @JavascriptInterface public void salvar(String nome, String tipo, String base64) {
            try { gravar(nome, tipo, Base64.decode(base64, Base64.DEFAULT)); }
            catch (Exception e) { aviso("Não deu para salvar: " + e.getMessage()); }
        }
    }

    String versao() {
        try { return getPackageManager().getPackageInfo(getPackageName(), 0).versionName; } catch (Exception e) { return "?"; }
    }

    // ---------- navegação ----------
    class Cliente extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
            Uri u = req.getUrl();
            String url = u.toString();
            if ("bluescreen".equals(u.getScheme())) { abrirDoLink(new Intent(Intent.ACTION_VIEW, u)); return true; }
            if (url.startsWith(CONECTAR)) return false;
            String o = Enderecos.origem(url);
            if (o != null && o.equals(servidor)) return false;
            // link para fora (documentação, GitHub...): no navegador do celular
            try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (ActivityNotFoundException ignored) { }
            return true;
        }

        @Override
        public void onPageStarted(WebView v, String url, android.graphics.Bitmap icone) {
            naConexao = url != null && url.startsWith(CONECTAR);
        }

        @Override
        public void onReceivedError(WebView v, WebResourceRequest req, WebResourceError erro) {
            if (!req.isForMainFrame() || naConexao) return;
            String pc = servidor == null ? "o PC" : servidor.replace("http://", "");
            conectar("Não deu para abrir " + pc + " (" + erro.getDescription() + "). Confira se o PC está ligado, na mesma rede Wi-Fi e com a Rede local ligada no BlueScreen.");
        }
    }

    class Chrome extends WebChromeClient {
        @Override
        public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams p) {
            if (arquivos != null) arquivos.onReceiveValue(null);
            arquivos = cb;
            Intent i = p.createIntent();
            if (p.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
            try { startActivityForResult(i, ESCOLHER_ARQUIVO); return true; }
            catch (ActivityNotFoundException e) { arquivos = null; return false; }
        }
    }

    @Override
    protected void onActivityResult(int pedido, int resultado, Intent dados) {
        if (pedido != ESCOLHER_ARQUIVO || arquivos == null) { super.onActivityResult(pedido, resultado, dados); return; }
        Uri[] r = null;
        if (resultado == RESULT_OK && dados != null) {
            if (dados.getClipData() != null) {
                r = new Uri[dados.getClipData().getItemCount()];
                for (int i = 0; i < r.length; i++) r[i] = dados.getClipData().getItemAt(i).getUri();
            } else if (dados.getData() != null) r = new Uri[]{dados.getData()};
        }
        arquivos.onReceiveValue(r);
        arquivos = null;
    }

    // ---------- downloads ----------
    void baixar(String url, String agente, String disposicao, String tipo, long tamanho) {
        String nome = URLUtil.guessFileName(url, disposicao, tipo);
        if (url.startsWith("blob:") || url.startsWith("data:")) {
            // o arquivo só existe na página: ela lê e manda em base64 pela ponte
            String js = "(async()=>{try{const b=await (await fetch(" + JSONObject.quote(url) + ")).blob();const r=new FileReader();"
                    + "r.onload=()=>BSApp.salvar(" + JSONObject.quote(nome) + ",b.type||" + JSONObject.quote(tipo == null ? "" : tipo) + ",String(r.result).split(',')[1]||'');"
                    + "r.readAsDataURL(b);}catch(e){}})()";
            web.evaluateJavascript(js, null);
            return;
        }
        try {
            DownloadManager.Request r = new DownloadManager.Request(Uri.parse(url));
            String cookies = CookieManager.getInstance().getCookie(url);
            if (cookies != null) r.addRequestHeader("Cookie", cookies);
            r.addRequestHeader("User-Agent", agente);
            if (tipo != null) r.setMimeType(tipo);
            r.setTitle(nome);
            r.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            if (Build.VERSION.SDK_INT >= 29) r.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, nome);
            else r.setDestinationInExternalFilesDir(this, Environment.DIRECTORY_DOWNLOADS, nome);
            ((DownloadManager) getSystemService(DOWNLOAD_SERVICE)).enqueue(r);
            aviso("Baixando " + nome);
        } catch (Exception e) { aviso("Não deu para baixar: " + e.getMessage()); }
    }

    void gravar(String nome, String tipo, byte[] dados) throws Exception {
        if (Build.VERSION.SDK_INT >= 29) {
            ContentValues v = new ContentValues();
            v.put(MediaStore.Downloads.DISPLAY_NAME, nome);
            if (tipo != null && !tipo.isEmpty()) v.put(MediaStore.Downloads.MIME_TYPE, tipo);
            Uri u = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
            if (u == null) throw new Exception("pasta Downloads indisponível");
            try (OutputStream o = getContentResolver().openOutputStream(u)) { if (o == null) throw new Exception("sem acesso"); o.write(dados); }
            aviso("Salvo em Downloads: " + nome);
        } else {
            File dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
            File f = new File(dir, nome);
            try (FileOutputStream o = new FileOutputStream(f)) { o.write(dados); }
            aviso("Salvo em " + f.getAbsolutePath());
        }
    }

    void aviso(String t) { runOnUiThread(() -> Toast.makeText(this, t, Toast.LENGTH_SHORT).show()); }

    // ---------- voltar ----------
    /** Na IDE: o primeiro "voltar" fecha o que estiver aberto (como Esc); o segundo, em 2 s, volta à escolha do PC. */
    void voltar() {
        // na escolha do PC, voltar sai do app (o histórico tem a IDE de antes, e voltar para ela sem o PC escolhido
        // deixaria o app sem saber com quem fala)
        if (naConexao) { finish(); return; }
        long agora = System.currentTimeMillis();
        if (agora - voltouEm < 2000) { voltouEm = 0; conectar(null); return; }
        voltouEm = agora;
        web.evaluateJavascript("(()=>{const t=document.activeElement||document.body;const o={key:'Escape',code:'Escape',keyCode:27,which:27,bubbles:true,cancelable:true};"
                + "t.dispatchEvent(new KeyboardEvent('keydown',o));t.dispatchEvent(new KeyboardEvent('keyup',o));})()", null);
        aviso("Toque em voltar de novo para trocar de PC");
    }

    /** Android 12 e anteriores; do 13 em diante o gesto chega pelo OnBackInvokedCallback registrado no onCreate */
    @SuppressWarnings("deprecation")
    @android.annotation.SuppressLint("GestureBackNavigation")
    @Override
    public void onBackPressed() { voltar(); }

    @Override
    protected void onPause() {
        super.onPause();
        CookieManager.getInstance().flush(); // a sessão (PIN) sobrevive ao app fechado
    }

    @Override
    protected void onDestroy() {
        fila.shutdownNow();
        web.destroy();
        super.onDestroy();
    }
}
