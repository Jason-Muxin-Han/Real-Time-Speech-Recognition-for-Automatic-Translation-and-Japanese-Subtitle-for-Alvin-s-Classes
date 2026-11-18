import com.sun.net.httpserver.*;
import javax.swing.*;
import java.awt.*;
import java.awt.event.*;
import java.io.*;
import java.net.*;
import java.net.http.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.concurrent.*;
import java.util.regex.*;

public class KotobaLive {
    static final int PORT = Integer.parseInt(System.getenv().getOrDefault("PORT", "8765"));
    static final String TOKEN = Base64.getUrlEncoder().withoutPadding().encodeToString(new SecureRandom().generateSeed(24));
    static Process worker;
    static BufferedWriter workerIn;
    static BufferedReader workerOut;
    static volatile String subtitle = "字幕がここに表示されます";
    static JLabel label;
    static JFrame overlay;

    public static void main(String[] args) throws Exception {
        if (GraphicsEnvironment.isHeadless()) throw new IllegalStateException("A graphical desktop is required");
        worker = new ProcessBuilder("./engine/kotoba-engine").redirectError(ProcessBuilder.Redirect.INHERIT).start();
        workerIn = new BufferedWriter(new OutputStreamWriter(worker.getOutputStream(), StandardCharsets.UTF_8));
        workerOut = new BufferedReader(new InputStreamReader(worker.getInputStream(), StandardCharsets.UTF_8));
        Runtime.getRuntime().addShutdownHook(new Thread(() -> worker.destroy()));
        SwingUtilities.invokeAndWait(KotobaLive::createOverlay);
        HttpServer server = HttpServer.create(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), PORT), 0);
        server.createContext("/", KotobaLive::handle);
        server.setExecutor(Executors.newFixedThreadPool(4));
        server.start();
        System.out.println("Kotoba Live: http://127.0.0.1:" + PORT);
        System.out.println("Local speech and translation engine started.");
    }

    static void createOverlay() {
        overlay = new JFrame("Kotoba Live 字幕");
        overlay.setUndecorated(true);
        overlay.setAlwaysOnTop(true);
        overlay.setBackground(new Color(0, 0, 0, 0));
        overlay.setDefaultCloseOperation(WindowConstants.DO_NOTHING_ON_CLOSE);
        label = new JLabel("<html><div style='text-align:center'>" + subtitle + "</div></html>", SwingConstants.CENTER);
        label.setForeground(Color.WHITE);
        label.setFont(new Font(Font.SANS_SERIF, Font.BOLD, 28));
        label.setBorder(BorderFactory.createEmptyBorder(12, 24, 12, 24));
        label.setOpaque(false);
        overlay.add(label);
        overlay.setSize(850, 110);
        Dimension screen = Toolkit.getDefaultToolkit().getScreenSize();
        overlay.setLocation(Math.max(0, (screen.width - 850) / 2), Math.max(0, screen.height - 190));
        MouseAdapter drag = new MouseAdapter() {
            Point start;
            public void mousePressed(MouseEvent e) { start = e.getPoint(); }
            public void mouseDragged(MouseEvent e) { Point p = e.getLocationOnScreen(); overlay.setLocation(p.x - start.x, p.y - start.y); }
        };
        label.addMouseListener(drag); label.addMouseMotionListener(drag);
        overlay.setVisible(true);
    }

    static void handle(HttpExchange x) throws IOException {
        try {
            String path = x.getRequestURI().getPath();
            if (!"127.0.0.1:".concat(String.valueOf(PORT)).equals(x.getRequestHeaders().getFirst("Host"))) { reply(x, 403, "text/plain", "Forbidden"); return; }
            if (path.equals("/") && x.getRequestMethod().equals("GET")) {
                String html = Files.readString(Path.of("web/index.html")).replace("__TOKEN__", TOKEN);
                reply(x, 200, "text/html; charset=utf-8", html); return;
            }
            if (!TOKEN.equals(x.getRequestHeaders().getFirst("X-Kotoba-Token"))) { reply(x, 403, "text/plain", "Forbidden"); return; }
            if (path.equals("/api/settings") && x.getRequestMethod().equals("POST")) {
                String body = new String(x.getRequestBody().readNBytes(1024), StandardCharsets.UTF_8);
                String[] parts = body.split(",");
                int opacity = Math.max(0, Math.min(95, Integer.parseInt(parts[0])));
                int size = Math.max(18, Math.min(60, Integer.parseInt(parts[1])));
                boolean visible = Boolean.parseBoolean(parts[2]);
                Color color = Color.decode(parts[3]);
                SwingUtilities.invokeLater(() -> { label.setOpaque(opacity > 0); label.setBackground(new Color(0, 0, 0, opacity * 255 / 100)); label.setForeground(color); label.setFont(new Font(Font.SANS_SERIF, Font.BOLD, size)); overlay.setVisible(visible); label.repaint(); });
                reply(x, 200, "application/json", "{\"ok\":true}"); return;
            }
            if (path.equals("/api/transcribe") && x.getRequestMethod().equals("POST")) {
                byte[] audio = x.getRequestBody().readNBytes(10_000_001);
                if (audio.length == 0 || audio.length > 10_000_000) { reply(x, 400, "text/plain", "音频为空或过大。"); return; }
                String result = processAudio(audio);
                String original = jsonField(result, "original");
                String translation = jsonField(result, "translation");
                if (translation.isEmpty()) { reply(x, 200, "application/json", result); return; }
                subtitle = translation;
                SwingUtilities.invokeLater(() -> label.setText("<html><div style='text-align:center'>" + escapeHtml(translation) + "</div></html>"));
                reply(x, 200, "application/json; charset=utf-8", "{\"original\":" + quote(original) + ",\"translation\":" + quote(translation) + "}"); return;
            }
            reply(x, 404, "text/plain", "Not found");
        } catch (Exception e) { e.printStackTrace(); reply(x, 500, "text/plain; charset=utf-8", "本地识别失败，请检查启动窗口中的错误信息。 " + e.getMessage()); }
    }
    static synchronized String processAudio(byte[] audio) throws IOException {
        workerIn.write(Base64.getEncoder().encodeToString(audio)); workerIn.newLine(); workerIn.flush();
        String line = workerOut.readLine();
        if (line == null || line.contains("\"error\"")) throw new IOException("识别引擎不可用");
        return line;
    }
    static String jsonField(String json, String key) throws IOException {
        Matcher m = Pattern.compile("\\\"" + Pattern.quote(key) + "\\\"\\s*:\\s*\\\"((?:\\\\.|[^\\\"\\\\])*)\\\"").matcher(json);
        if (!m.find()) throw new IOException("服务响应缺少 " + key);
        String s = m.group(1); StringBuilder b = new StringBuilder();
        for (int i = 0; i < s.length(); i++) { char c = s.charAt(i); if (c != '\\') { b.append(c); continue; } c = s.charAt(++i); switch (c) { case 'n': b.append('\n'); break; case 'r': b.append('\r'); break; case 't': b.append('\t'); break; case 'b': b.append('\b'); break; case 'f': b.append('\f'); break; case 'u': b.append((char)Integer.parseInt(s.substring(i+1, i+5),16)); i+=4; break; default: b.append(c); } }
        return b.toString();
    }
    static String quote(String s) { StringBuilder b = new StringBuilder("\""); for (char c : s.toCharArray()) { switch(c) { case '"': b.append("\\\""); break; case '\\': b.append("\\\\"); break; case '\n': b.append("\\n"); break; case '\r': b.append("\\r"); break; case '\t': b.append("\\t"); break; default: if (c < 32) b.append(String.format("\\u%04x", (int)c)); else b.append(c); } } return b.append('"').toString(); }
    static String escapeHtml(String s) { return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\n", "<br>"); }
    static void reply(HttpExchange x, int code, String type, String body) throws IOException { byte[] data = body.getBytes(StandardCharsets.UTF_8); x.getResponseHeaders().set("Content-Type", type); x.getResponseHeaders().set("Cache-Control", "no-store"); x.getResponseHeaders().set("X-Content-Type-Options", "nosniff"); x.sendResponseHeaders(code, data.length); try (OutputStream o = x.getResponseBody()) { o.write(data); } }
}
