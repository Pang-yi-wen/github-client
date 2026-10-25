package com.pangyiwen.ghclient;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageInfo;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.Settings;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.JsResult;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.regex.Matcher;
import java.util.HashMap;
import java.util.regex.Pattern;

/**
 * 单文件客户端外壳。内置页面首次运行时复制到可写目录后加载，
 * 页面自身的 GitHub 请求由页面直连官方接口，不经任何中转。
 */
public class MainActivity extends Activity {

    private static final String SELF = "Pang-yi-wen/github-client";
    /** raw 通道候选，与网页版一致；国内网络下前一个不通时依次尝试多个代理镜像 */
    private static final String[] RAW = {
        "https://raw.githubusercontent.com/",
        "https://ghproxy.net/https://raw.githubusercontent.com/",
        "https://mirror.ghproxy.com/https://raw.githubusercontent.com/",
        "https://github.moeyy.xyz/https://raw.githubusercontent.com/",
        "https://raw.gitmirror.com/",
        "https://ghfast.top/https://raw.githubusercontent.com/",
        "https://gh-proxy.org/https://raw.githubusercontent.com/",
        "https://gh-proxy.com/https://raw.githubusercontent.com/"
    };
    /** 安装包版本清单在仓库里的路径 */
    private static final String APK_META_PATH = SELF + "/main/android/apk/version.json";

    private WebView webView;
    private View zoomBar;
    private String localVersion = "";
    private long pendingDownloadId = -1;
    /** 通用文件下载：记录下载 id 与显示名，完成后提示已保存 */
    private final HashMap<Long, String> fileNames = new HashMap<>();

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        File boot = new File(getFilesDir(), "boot.html");
        try {
            ensurePage();
        } catch (Exception ignore) {
            boot = null;   // 复制失败退回直接读 asset
        }

        WebView wv = new WebView(this);
        WebSettings s = wv.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);                  // 令牌、缓存、设置都存 localStorage
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);                    // API 30+ 默认 false，否则文件页面加载失败
        s.setAllowFileAccessFromFileURLs(true);
        s.setAllowUniversalAccessFromFileURLs(true);   // file:// 页面直连 api.github.com 等接口
        s.setTextZoom(100);                            // 排版不跟随系统字体缩放
        s.setSupportZoom(true);                        // 双指捏合缩放
        s.setBuiltInZoomControls(true);
        s.setDisplayZoomControls(false);               // 不显示系统缩放按钮，用右下角自定义控件
        wv.addJavascriptInterface(this, "Android");
        // WebView 默认不弹 confirm/alert，页面里的删除确认会静默失败，这里补齐
        wv.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onJsConfirm(WebView view, String url, String message, final JsResult result) {
                new AlertDialog.Builder(MainActivity.this)
                    .setMessage(message)
                    .setPositiveButton("确定", (d, w) -> result.confirm())
                    .setNegativeButton("取消", (d, w) -> result.cancel())
                    .setOnCancelListener(d -> result.cancel())
                    .show();
                return true;
            }

            @Override
            public boolean onJsAlert(WebView view, String url, String message, final JsResult result) {
                new AlertDialog.Builder(MainActivity.this)
                    .setMessage(message)
                    .setPositiveButton("确定", (d, w) -> result.confirm())
                    .setOnCancelListener(d -> result.confirm())
                    .show();
                return true;
            }
        });
        wv.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return handle(request.getUrl().toString());
            }

            @Override
            @SuppressWarnings("deprecation")
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return handle(url);
            }

            /** 应用内页面自行加载，站外链接交系统浏览器 */
            private boolean handle(String url) {
                if (url == null) return false;
                if (url.startsWith("file:///") || url.startsWith("about:") || url.startsWith("data:")) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)));
                } catch (Exception ignore) {
                    return false;
                }
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                observeModal(view);
                view.evaluateJavascript(
                    "(function(){try{return APP_VERSION||''}catch(e){return ''}})()",
                    v -> {
                        localVersion = v == null ? "" : v.replaceAll("^\"|\"$", "");
                        if (!localVersion.isEmpty()) checkUpdate();
                    });
                checkApkUpdate();
            }
        });
        wv.loadUrl(boot != null ? "file://" + boot.getAbsolutePath() : "file:///android_asset/boot.html");
        setContentView(wv);
        webView = wv;
        addZoomBar();

        IntentFilter f = new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(apkReady, f, Context.RECEIVER_NOT_EXPORTED);
            registerReceiver(fileReady, f, Context.RECEIVER_NOT_EXPORTED);
        } else {
            registerReceiver(apkReady, f);
            registerReceiver(fileReady, f);
        }
    }

    @Override
    protected void onDestroy() {
        try {
            unregisterReceiver(apkReady);
        } catch (Exception ignore) {
        }
        super.onDestroy();
    }

    @Override
    public void onBackPressed() {
        // 应用内是 hash 路由，先走 WebView 历史，再无路可走才退出
        if (webView != null && webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    /* ----------------------------- 缩放控件 ----------------------------- */

    /**
     * 注入观察器：页面里的模态框（设置面板等）打开时收起悬浮控件，避免压在弹窗上。
     * 轮询式方案会被 WebView 的 JS 执行节流，MutationObserver 由页面事件直接驱动。
     */
    private void observeModal(WebView view) {
        view.evaluateJavascript(
            "(function(){var m=document.getElementById('modal');if(!m||window.__zoomObs)return;" +
            "window.__zoomObs=new MutationObserver(function(){Android.setZoomVisible(m.hidden)});" +
            "window.__zoomObs.observe(m,{attributes:true,attributeFilter:['hidden']});" +
            "Android.setZoomVisible(m.hidden);})()", null);
    }

    @JavascriptInterface
    public void setZoomVisible(final boolean visible) {
        runOnUiThread(() -> {
            if (zoomBar != null) zoomBar.setVisibility(visible ? View.VISIBLE : View.GONE);
        });
    }

    /** 供页面显示壳版本，与页面版本（VERSION 文件）区分 */
    @JavascriptInterface
    public String shellVersion() {
        try {
            return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (Exception e) {
            return "";
        }
    }

    /** 右下角悬浮缩放条：与双指捏合共用 WebView 的缩放引擎，只缩放显示，不改排版 */
    private void addZoomBar() {
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(0xCC1C2128);
        bg.setCornerRadius(dp(10));

        Button plus = zoomButton("＋", "放大", bg);
        Button minus = zoomButton("－", "缩小", bg);
        plus.setOnClickListener(v -> webView.zoomIn());
        minus.setOnClickListener(v -> webView.zoomOut());

        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.VERTICAL);
        bar.addView(plus, new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        bar.addView(minus, new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        FrameLayout root = findViewById(android.R.id.content);
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT,
            Gravity.END | Gravity.BOTTOM);
        lp.setMargins(0, 0, dp(12), dp(28));
        root.addView(bar, lp);
        zoomBar = bar;
    }

    private Button zoomButton(String text, String desc, GradientDrawable bg) {
        Button b = new Button(this);
        b.setText(text);
        b.setContentDescription(desc);
        b.setTextColor(0xFFE6EDF3);
        b.setTextSize(18);
        b.setAllCaps(false);
        b.setMinWidth(0);
        b.setMinHeight(0);
        b.setMinimumWidth(0);
        b.setMinimumHeight(0);
        b.setPadding(dp(14), dp(6), dp(14), dp(6));
        b.setBackground(bg);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.setMargins(0, 0, 0, dp(6));
        b.setLayoutParams(lp);
        return b;
    }

    private int dp(int v) {
        return (int) (v * getResources().getDisplayMetrics().density + 0.5f);
    }

    /* --------------------------- 安装包自更新 --------------------------- */

    /** 下载完成 → 直接调起系统安装器（URI 由 DownloadManager 授权，无需 FileProvider） */
    private final BroadcastReceiver apkReady = new BroadcastReceiver() {
        @Override
        public void onReceive(Context ctx, Intent intent) {
            long id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1);
            if (id != pendingDownloadId) return;
            pendingDownloadId = -1;
            DownloadManager dm = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
            Uri uri = dm.getUriForDownloadedFile(id);
            if (uri == null) return;
            Intent install = new Intent(Intent.ACTION_VIEW);
            install.setDataAndType(uri, "application/vnd.android.package-archive");
            install.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            try {
                startActivity(install);
            } catch (Exception e) {
                Toast.makeText(MainActivity.this, "无法调起安装器，请在下载目录手动安装", Toast.LENGTH_LONG).show();
            }
        }
    };

    /** 通用文件下载完成 → 提示已保存到下载目录 */
    private final BroadcastReceiver fileReady = new BroadcastReceiver() {
        @Override
        public void onReceive(Context ctx, Intent intent) {
            long id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1);
            String name = fileNames.remove(id);
            if (name == null) return;
            Toast.makeText(MainActivity.this, "已保存到下载目录：" + name, Toast.LENGTH_LONG).show();
        }
    };

    private void checkApkUpdate() {
        new Thread(() -> {
            String t = fetchTextRace(candidateUrls(APK_META_PATH.substring(SELF.length())), 12000);
            if (t == null) return;
            final long remoteCode;
            final String remoteName, apkName;
            try {
                JSONObject j = new JSONObject(t);
                remoteCode = j.getLong("versionCode");
                remoteName = j.getString("versionName");
                apkName = j.getString("apk");
            } catch (Exception e) {
                return;
            }
            if (remoteCode <= installedVersionCode()) return;
            runOnUiThread(() -> new AlertDialog.Builder(this)
                .setTitle("发现新版本 " + remoteName)
                .setMessage("是否下载并安装新版本？")
                .setPositiveButton("下载", (d, w) -> downloadApk(remoteName, apkName))
                .setNegativeButton("稍后", null)
                .show());
        }).start();
    }

    private long installedVersionCode() {
        try {
            PackageInfo pi = getPackageManager().getPackageInfo(getPackageName(), 0);
            return Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? pi.getLongVersionCode() : pi.versionCode;
        } catch (Exception e) {
            return 0;
        }
    }

    private void downloadApk(String ver, String apkName) {
        // API 26+ 安装未知应用需用户显式授权，缺权限时先引导去开启
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !getPackageManager().canRequestPackageInstalls()) {
            try {
                startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + getPackageName())));
            } catch (Exception ignore) {
            }
            Toast.makeText(this, "请允许本应用「安装未知应用」后重试", Toast.LENGTH_LONG).show();
            return;
        }
        final String url = pickApkUrl(apkName);
        if (url == null) {
            Toast.makeText(this, "无法连接下载源，请稍后重试", Toast.LENGTH_LONG).show();
            return;
        }
        DownloadManager dm = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
        DownloadManager.Request r = new DownloadManager.Request(Uri.parse(url));
        r.setTitle("GitHub 客户端 " + ver);
        r.setDescription("正在下载安装包");
        r.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, "GitHubClient-" + ver + ".apk");
        r.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
        pendingDownloadId = dm.enqueue(r);
        Toast.makeText(this, "已开始下载，完成后自动调起安装", Toast.LENGTH_LONG).show();
    }

    /** 供页面调用：用系统下载管理器抓取任意 URL，带通知栏进度，落盘到下载目录 */
    @JavascriptInterface
    public void downloadFile(String url, String name) {
        if (url == null || url.isEmpty()) {
            runOnUiThread(() -> Toast.makeText(this, "下载地址为空", Toast.LENGTH_SHORT).show());
            return;
        }
        if (name == null || name.isEmpty()) {
            name = url.substring(url.lastIndexOf('/') + 1);
        }
        if (name.isEmpty()) name = "github-file";
        DownloadManager dm = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
        DownloadManager.Request r = new DownloadManager.Request(Uri.parse(url));
        r.setTitle(name);
        r.setDescription("正在下载文件");
        r.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
        r.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
        r.allowScanningByMediaScanner();
        try {
            long id = dm.enqueue(r);
            final String shown = name;
            fileNames.put(id, shown);
            runOnUiThread(() -> Toast.makeText(this,
                "已开始下载：" + shown + "（进度见通知栏）", Toast.LENGTH_LONG).show());
        } catch (Exception e) {
            runOnUiThread(() -> Toast.makeText(this, "下载失败：" + e.getMessage(), Toast.LENGTH_LONG).show());
        }
    }

    /** DownloadManager 只接受单个地址，并行 HEAD 探明第一个可用的 */
    private String pickApkUrl(String apkName) {
        if (apkName == null || apkName.isEmpty()) return null;
        return firstReachable(candidateUrls("/main/android/apk/" + apkName), 8000);
    }

    /* ------------------------- 页面落地与更新 ------------------------- */

    private File pageFile() {
        return new File(getFilesDir(), "index.html");
    }

    /**
     * 首次运行把内置页面复制到可写目录；安装包里的页面比本地新才覆盖。
     * 本地页面可能经更新通道下载了比安装包更新的版本，那种情况必须保留——
     * 早先按文件长度判断，会把更新下载的页面在每次重启时降级回安装包版本，
     * 导致更新提示反复出现。
     */
    private void ensurePage() throws Exception {
        byte[] asset = readAll(getAssets().open("index.html"));
        File page = pageFile();
        if (!page.exists()) {
            writeFile(page, asset);
        } else {
            byte[] local = readAll(new FileInputStream(page));
            if (compareVer(pageVersion(asset), pageVersion(local)) > 0) writeFile(page, asset);
        }
        copyAsset("boot.html", new File(getFilesDir(), "boot.html"));
    }

    private static byte[] readAll(InputStream in) throws Exception {
        try (InputStream s = in) {
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            int n;
            while ((n = s.read(buf)) > 0) bos.write(buf, 0, n);
            return bos.toByteArray();
        }
    }

    private static void writeFile(File f, byte[] data) throws Exception {
        try (OutputStream out = new FileOutputStream(f)) {
            out.write(data);
        }
    }

    /** 读取构建时注入的 APP_VERSION，读不到返回空串（视为最旧） */
    private static String pageVersion(byte[] html) {
        Matcher m = Pattern.compile("APP_VERSION\\s*=\\s*'([^']+)'").matcher(new String(html, StandardCharsets.UTF_8));
        return m.find() ? m.group(1) : "";
    }

    private void copyAsset(String name, File dst) throws Exception {
        try (InputStream in = getAssets().open(name); OutputStream out = new FileOutputStream(dst)) {
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        }
    }

    private void checkUpdate() {
        new Thread(() -> {
            String remote = fetchRemoteVersion();
            if (remote == null || compareVer(remote, localVersion) <= 0) return;
            runOnUiThread(() -> new AlertDialog.Builder(this)
                .setTitle("发现新版本 " + remote)
                .setMessage("当前版本 " + localVersion + "，是否现在更新？")
                .setPositiveButton("更新", (d, w) -> doUpdate(remote))
                .setNegativeButton("稍后", null)
                .show());
        }).start();
    }

    private void doUpdate(String remote) {
        Toast.makeText(this, "正在下载 " + remote, Toast.LENGTH_SHORT).show();
        new Thread(() -> {
            // 并行竞速取最快通道的页面，校验完整后再落盘，避免把错误页写进去
            String html = fetchTextRace(candidateUrls("/main/GitHub.html"), 20000);
            if (html == null || html.length() <= 50000 || !html.contains("GitHub")) {
                runOnUiThread(() -> Toast.makeText(this, "更新失败：无法获取新版本文件", Toast.LENGTH_LONG).show());
                return;
            }
            try {
                File tmp = new File(getFilesDir(), "index.html.tmp");
                try (OutputStream out = new FileOutputStream(tmp)) {
                    out.write(html.getBytes("UTF-8"));
                }
                File page = pageFile();
                if (!tmp.renameTo(page)) {
                    try (OutputStream out = new FileOutputStream(page)) {
                        out.write(html.getBytes("UTF-8"));
                    }
                }
                tmp.delete();
                runOnUiThread(() -> {
                    webView.reload();
                    Toast.makeText(this, "已更新到 " + remote, Toast.LENGTH_LONG).show();
                });
            } catch (Exception e) {
                runOnUiThread(() -> Toast.makeText(this, "更新失败：" + e.getMessage(), Toast.LENGTH_LONG).show());
            }
        }).start();
    }

    private String fetchRemoteVersion() {
        String t = fetchTextRace(candidateUrls("/main/VERSION"), 12000);
        if (t == null) return null;
        String v = t.trim().split("\n")[0].trim();
        return v.isEmpty() ? null : v;
    }

    private String fetchText(String url) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(15000);
            c.setReadTimeout(20000);
            if (c.getResponseCode() != 200) return null;
            InputStream in = c.getInputStream();
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
            return new String(bos.toByteArray(), "UTF-8");
        } catch (Exception ignore) {
            return null;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private String fetchText(String url, int connectMs, int readMs) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(connectMs);
            c.setReadTimeout(readMs);
            if (c.getResponseCode() != 200) return null;
            InputStream in = c.getInputStream();
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
            return new String(bos.toByteArray(), "UTF-8");
        } catch (Exception ignore) {
            return null;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    /** 构造仓库内某文件的全部候选 URL（含 jsDelivr CDN），与网页版镜像池一致 */
    private String[] candidateUrls(String pathAfterRepo) {
        ArrayList<String> out = new ArrayList<>();
        String branch = "main";
        String rest = pathAfterRepo;
        if (rest.startsWith("/" + branch + "/")) rest = rest.substring(branch.length() + 2);
        out.add("https://cdn.jsdelivr.net/gh/" + SELF + "@" + branch + "/" + rest);
        for (String host : RAW) out.add(host + SELF + pathAfterRepo);
        return out.toArray(new String[0]);
    }

    /** 并行 GET 所有候选，返回第一个成功响应的文本；全部失败返回 null（首响即胜，其余取消） */
    private String fetchTextRace(String[] urls, int timeoutMs) {
        if (urls == null || urls.length == 0) return null;
        ExecutorService ex = Executors.newCachedThreadPool();
        AtomicReference<String> out = new AtomicReference<>(null);
        AtomicBoolean won = new AtomicBoolean(false);
        AtomicInteger pending = new AtomicInteger(urls.length);
        CountDownLatch latch = new CountDownLatch(1);
        for (final String u : urls) {
            ex.submit(() -> {
                if (won.get()) return;
                String t = fetchText(u, timeoutMs, timeoutMs);
                if (t != null && won.compareAndSet(false, true)) {
                    out.set(t);
                    latch.countDown();
                    return;
                }
                if (pending.decrementAndGet() == 0 && !won.get()) latch.countDown();
            });
        }
        try { latch.await(timeoutMs + 4000, TimeUnit.MILLISECONDS); } catch (InterruptedException ignore) {}
        won.set(true);
        ex.shutdownNow();
        return out.get();
    }

    /** 并行 HEAD 探测，返回第一个可达（200）的 URL；全部失败返回 null */
    private String firstReachable(String[] urls, int timeoutMs) {
        if (urls == null || urls.length == 0) return null;
        ExecutorService ex = Executors.newCachedThreadPool();
        AtomicReference<String> out = new AtomicReference<>(null);
        AtomicBoolean won = new AtomicBoolean(false);
        AtomicInteger pending = new AtomicInteger(urls.length);
        CountDownLatch latch = new CountDownLatch(1);
        for (final String u : urls) {
            ex.submit(() -> {
                if (won.get()) return;
                if (httpHeadOk(u, timeoutMs) && won.compareAndSet(false, true)) {
                    out.set(u);
                    latch.countDown();
                    return;
                }
                if (pending.decrementAndGet() == 0 && !won.get()) latch.countDown();
            });
        }
        try { latch.await(timeoutMs + 4000, TimeUnit.MILLISECONDS); } catch (InterruptedException ignore) {}
        won.set(true);
        ex.shutdownNow();
        return out.get();
    }

    private boolean httpHeadOk(String url, int timeoutMs) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setRequestMethod("HEAD");
            c.setConnectTimeout(timeoutMs);
            c.setReadTimeout(timeoutMs);
            return c.getResponseCode() == 200;
        } catch (Exception ignore) {
            return false;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    /** 版本号按点分段做数值比较 */
    private static int compareVer(String a, String b) {
        String[] pa = a.split("\\."), pb = b.split("\\.");
        for (int i = 0, n = Math.max(pa.length, pb.length); i < n; i++) {
            int x = num(i < pa.length ? pa[i] : "");
            int y = num(i < pb.length ? pb[i] : "");
            if (x != y) return x < y ? -1 : 1;
        }
        return 0;
    }

    private static int num(String s) {
        try {
            return Integer.parseInt(s.trim().replaceAll("[^0-9]", ""));
        } catch (Exception e) {
            return 0;
        }
    }
}
