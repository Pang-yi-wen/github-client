package com.pangyiwen.ghclient;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.Dialog;
import android.app.DownloadManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
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
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONArray;
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
    /** 本次启动是否已弹出页面更新提示，避免同一次加载里再弹安装包提示 */
    private boolean pageUpdatePrompted = false;
    /** 本次启动是否已经开始检查更新，boot.html 与 index.html 会各触发一次 onPageFinished */
    private volatile boolean updateChecksStarted = false;
    /** 安装包更新弹窗是否正在显示，避免同一版本叠两个对话框 */
    private volatile boolean apkDialogShowing = false;
    private static final String PREF = "ghclient";

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
        // 兜底：页面直接触发的 http(s) 下载交给系统下载器；blob: 在 WebView 里无法落盘
        wv.setDownloadListener((url, ua, cd, mime, len) -> {
            if (url == null) return;
            if (url.startsWith("blob:")) {
                runOnUiThread(() -> Toast.makeText(this,
                    "该下载方式需要新版安装包，请先更新", Toast.LENGTH_LONG).show());
                return;
            }
            if (url.startsWith("http://") || url.startsWith("https://")) {
                downloadFile(url, android.webkit.URLUtil.guessFileName(url, cd, mime));
            }
        });
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
                        // boot.html 没有 APP_VERSION，只有真正加载了页面才检查；
                        // 否则 boot→index 两次 onPageFinished 会把同一版本弹两遍
                        if (!localVersion.isEmpty()) runUpdateChecks();
                    });
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
            markDownloadDone(id);
            Toast.makeText(MainActivity.this, "已保存到下载目录：" + name, Toast.LENGTH_LONG).show();
        }
    };

    /** 供页面「检查更新」调用：手动触发安装包检查，忽略“已提示过”的限制 */
    @JavascriptInterface
    public void checkApkUpdate() {
        checkApkUpdate(true);
    }

    private void checkApkUpdate(boolean manual) {
        new Thread(() -> {
            String t = fetchTextRace(candidateUrls(APK_META_PATH.substring(SELF.length()), false), 12000);
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
            if (!manual) {
                // 同一次加载里刚提示过页面更新，不再连着弹安装包；同一版本只自动提示一次
                if (pageUpdatePrompted) return;
                if (getSharedPreferences(PREF, MODE_PRIVATE).getLong("apk_seen_code", 0) >= remoteCode) return;
            }
            if (apkDialogShowing) return;
            final String cur = installedVersionName();
            runOnUiThread(() -> {
                if (apkDialogShowing) return;
                apkDialogShowing = true;
                // 弹过即记为已提示：自动检查对同一版本只弹一次，彻底避免重复弹窗；
                // 若下载/安装失败，可在设置里点「检查更新」手动重试（手动不受此限制）
                markApkSeen(remoteCode);
                new AlertDialog.Builder(this)
                    .setTitle("安装包有新版本 " + remoteName)
                    .setMessage("当前安装包 " + (cur.isEmpty() ? "未知" : cur) + "，是否下载并安装？")
                    .setPositiveButton("下载", (d, w) -> downloadApk(remoteName, apkName))
                    .setNegativeButton("稍后", (d, w) -> markApkSeen(remoteCode))
                    .setOnCancelListener(d -> markApkSeen(remoteCode))
                    .setOnDismissListener(d -> apkDialogShowing = false)
                    .show();
            });
        }).start();
    }

    private void markApkSeen(long code) {
        getSharedPreferences(PREF, MODE_PRIVATE).edit().putLong("apk_seen_code", code).apply();
    }

    private long installedVersionCode() {
        try {
            PackageInfo pi = getPackageManager().getPackageInfo(getPackageName(), 0);
            return Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? pi.getLongVersionCode() : pi.versionCode;
        } catch (Exception e) {
            return 0;
        }
    }

    private String installedVersionName() {
        try {
            return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (Exception e) {
            return "";
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
            addDownloadRecord(id, shown);
            runOnUiThread(() -> Toast.makeText(this,
                "已开始下载：" + shown + "（进度见通知栏）", Toast.LENGTH_LONG).show());
        } catch (Exception e) {
            runOnUiThread(() -> Toast.makeText(this, "下载失败：" + e.getMessage(), Toast.LENGTH_LONG).show());
        }
    }

    /** 公共下载目录的绝对路径，供页面提示“文件保存在哪里” */
    @JavascriptInterface
    public String downloadDir() {
        try {
            return Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS).getAbsolutePath();
        } catch (Exception e) {
            return "内部存储/Download";
        }
    }

    /** 下载记录（最近 50 条），字段 id/name/time/done */
    @JavascriptInterface
    public String listDownloads() {
        return getSharedPreferences(PREF, MODE_PRIVATE).getString("downloads", "[]");
    }

    /** 打开已下载文件：用 DownloadManager 的内容 URI 交给系统应用 */
    @JavascriptInterface
    public void openDownload(long id) {
        try {
            DownloadManager dm = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
            final Uri uri = dm.getUriForDownloadedFile(id);
            if (uri == null) {
                runOnUiThread(() -> Toast.makeText(this, "文件不存在或已被移动", Toast.LENGTH_LONG).show());
                return;
            }
            String mime = null;
            try { mime = dm.getMimeTypeForDownloadedFile(id); } catch (Exception ignore) {}
            if (mime == null || mime.isEmpty()) mime = "application/octet-stream";
            Intent i = new Intent(Intent.ACTION_VIEW);
            i.setDataAndType(uri, mime);
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            try {
                startActivity(i);
            } catch (Exception e) {
                runOnUiThread(() -> Toast.makeText(this, "没有可打开该文件的应用", Toast.LENGTH_LONG).show());
            }
        } catch (Exception e) {
            runOnUiThread(() -> Toast.makeText(this, "无法打开：" + e.getMessage(), Toast.LENGTH_LONG).show());
        }
    }

    /** 尽力打开系统的“下载”目录；部分机型不支持则提示路径 */
    @JavascriptInterface
    public void openDownloadsFolder() {
        try {
            Intent i = new Intent(Intent.ACTION_VIEW);
            i.setDataAndType(Uri.parse("content://com.android.externalstorage.documents/document/primary%3ADownload"),
                    "vnd.android.document/directory");
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(i);
        } catch (Exception e) {
            runOnUiThread(() -> Toast.makeText(this, "请到 " + downloadDir() + " 查看", Toast.LENGTH_LONG).show());
        }
    }

    /** 在客户端内用弹窗 WebView 打开 GitHub 网页（注册/密码/2FA/用户名/注销/令牌） */
    @JavascriptInterface
    public void openWeb(String url) {
        if (url == null) return;
        if (!url.startsWith("https://github.com/") && !url.equals("https://github.com")) return;
        runOnUiThread(() -> showWebDialog(url));
    }

    private void showWebDialog(String url) {
        final Dialog d = new Dialog(this, android.R.style.Theme_DeviceDefault_Light_NoActionBar);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);

        final WebView wv = new WebView(this);
        WebSettings s = wv.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowFileAccessFromFileURLs(false);
        s.setAllowUniversalAccessFromFileURLs(false);
        wv.setWebViewClient(new WebViewClient() {
            @Override
            public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
                if (req != null && req.isForMainFrame()) showWebError(view, url);
            }

            @Override
            @SuppressWarnings("deprecation")
            public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
                showWebError(view, failingUrl == null ? url : failingUrl);
            }
        });

        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setPadding(16, 10, 8, 10);
        TextView title = new TextView(this);
        title.setText("GitHub");
        title.setTextSize(15);
        bar.addView(title, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        // 备用通道：改用系统浏览器（可能走了不同的代理/VPN），登录态也更稳定
        Button browser = new Button(this);
        browser.setText("浏览器");
        browser.setOnClickListener(v -> {
            try {
                String u = wv.getUrl();
                if (u == null || u.isEmpty() || u.startsWith("data:")) u = url;
                startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(u)));
            } catch (Exception e) {
                Toast.makeText(this, "无法调起浏览器", Toast.LENGTH_LONG).show();
            }
        });
        bar.addView(browser, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        Button close = new Button(this);
        close.setText("关闭");
        close.setOnClickListener(v -> d.dismiss());
        bar.addView(close, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        wv.loadUrl(url);

        root.addView(bar, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        root.addView(wv, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        d.setContentView(root);
        d.setOnDismissListener(x -> { try { wv.destroy(); } catch (Exception ignore) {} });
        d.show();
        try {
            d.getWindow().setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
        } catch (Exception ignore) {}
    }

    /** github.com 不可达时的说明页；账号类页面不能走第三方代理，只能换网络或换浏览器 */
    private void showWebError(WebView view, String url) {
        String safe = url == null ? "" : url.replace("&", "&amp;").replace("<", "&lt;");
        String html = "<html><head><meta name='viewport' content='width=device-width,initial-scale=1'></head>"
            + "<body style='font-family:sans-serif;padding:24px;line-height:1.75;color:#333'>"
            + "<h3 style='margin:0 0 10px'>无法连接 github.com</h3>"
            + "<p>当前网络到不了 github.com，注册/登录页面打不开。</p>"
            + "<p>账号类页面不能走第三方代理（会把密码和 Cookie 交给代理），可以点右上角「浏览器」"
            + "改用系统浏览器，或把下面的链接复制到能访问 github.com 的网络。</p>"
            + "<p style='word-break:break-all;color:#666;font-size:13px'>" + safe + "</p>"
            + "</body></html>";
        view.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
    }

    /** 记录一次下载，供页面“下载记录”展示 */
    private void addDownloadRecord(long id, String name) {
        try {
            SharedPreferences sp = getSharedPreferences(PREF, MODE_PRIVATE);
            JSONArray old = new JSONArray(sp.getString("downloads", "[]"));
            JSONArray out = new JSONArray();
            JSONObject rec = new JSONObject();
            rec.put("id", id);
            rec.put("name", name);
            rec.put("time", System.currentTimeMillis());
            rec.put("done", false);
            out.put(rec);
            for (int i = 0; i < old.length() && out.length() < 50; i++) out.put(old.get(i));
            sp.edit().putString("downloads", out.toString()).apply();
        } catch (Exception ignore) {}
    }

    private void markDownloadDone(long id) {
        try {
            SharedPreferences sp = getSharedPreferences(PREF, MODE_PRIVATE);
            JSONArray arr = new JSONArray(sp.getString("downloads", "[]"));
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.getJSONObject(i);
                if (o.optLong("id") == id) o.put("done", true);
            }
            sp.edit().putString("downloads", arr.toString()).apply();
        } catch (Exception ignore) {}
    }

    /** DownloadManager 只接受单个地址，并行 HEAD 探明第一个可用的 */
    private String pickApkUrl(String apkName) {
        if (apkName == null || apkName.isEmpty()) return null;
        // 安装包文件名带版本号，内容不会变，可以放心走 CDN
        return firstReachable(candidateUrls("/main/android/apk/" + apkName, true), 8000);
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
        return pageVersionText(new String(html, StandardCharsets.UTF_8));
    }

    private static String pageVersionText(String html) {
        Matcher m = Pattern.compile("APP_VERSION\\s*=\\s*'([^']+)'").matcher(html);
        return m.find() ? m.group(1) : "";
    }

    private void copyAsset(String name, File dst) throws Exception {
        try (InputStream in = getAssets().open(name); OutputStream out = new FileOutputStream(dst)) {
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        }
    }

    /**
     * 启动时统一检查：先看页面，页面无需更新再看安装包。
     * 串行执行，避免两个检查并发各自弹窗；boot.html 的加载不触发。
     */
    private void runUpdateChecks() {
        if (updateChecksStarted) return;
        updateChecksStarted = true;
        new Thread(() -> {
            String remote = fetchRemoteVersion();
            if (remote != null && compareVer(remote, localVersion) > 0) {
                runOnUiThread(() -> {
                    pageUpdatePrompted = true;
                    new AlertDialog.Builder(this)
                        .setTitle("页面有新版本 " + remote)
                        .setMessage("当前页面 " + localVersion + "，是否更新页面内容？")
                        .setPositiveButton("更新", (d, w) -> doUpdate(remote))
                        .setNegativeButton("稍后", null)
                        .show();
                });
                return;   // 先处理页面更新；安装包下次启动再提示
            }
            updateChecksStarted = false;   // 没发现页面更新，允许下次加载重试安装包检查
            checkApkUpdate(false);
        }).start();
    }

    private void doUpdate(String remote) {
        Toast.makeText(this, "正在下载 " + remote, Toast.LENGTH_SHORT).show();
        new Thread(() -> {
            // 并行竞速取最快通道；校验内容完整且页面版本不低于目标版本，避免镜像/缓存给旧页
            String html = fetchTextRace(candidateUrls("/main/GitHub.html", false), 20000, remote);
            if (html == null) {
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
                localVersion = remote;   // 内存里的版本同步，避免同一轮里再次判定为新版本
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
        String t = fetchTextRace(candidateUrls("/main/VERSION", false), 12000);
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

    /** 构造仓库内某文件的候选 URL。allowCdn=false 用于自更新路径（VERSION/version.json/GitHub.html）：
     *  jsDelivr 对 @main 有小时级强缓存，可能给出旧内容，造成“更新成功却仍提示新版本”。 */
    private String[] candidateUrls(String pathAfterRepo, boolean allowCdn) {
        ArrayList<String> out = new ArrayList<>();
        String branch = "main";
        String rest = pathAfterRepo;
        if (rest.startsWith("/" + branch + "/")) rest = rest.substring(branch.length() + 2);
        if (allowCdn) out.add("https://cdn.jsdelivr.net/gh/" + SELF + "@" + branch + "/" + rest);
        for (String host : RAW) out.add(host + SELF + pathAfterRepo);
        return out.toArray(new String[0]);
    }

    /** 并行 GET 所有候选，返回第一个成功响应的文本；全部失败返回 null（首响即胜，其余取消） */
    private String fetchTextRace(String[] urls, int timeoutMs) {
        return fetchTextRace(urls, timeoutMs, null);
    }

    /** 同上，并要求取到的页面版本不低于 minPageVer；镜像给出旧页时继续等其它通道 */
    private String fetchTextRace(String[] urls, int timeoutMs, String minPageVer) {
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
                boolean ok = t != null && (minPageVer == null || compareVer(pageVersionText(t), minPageVer) >= 0);
                if (ok && won.compareAndSet(false, true)) {
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
