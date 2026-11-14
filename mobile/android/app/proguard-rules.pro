# A ponte com a página (window.BSApp) é chamada pelo nome, do JavaScript: os métodos não podem ser renomeados.
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
