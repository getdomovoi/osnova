import java.util.List;

public class App {
    private static final int MAX_ITEMS = 10;

    public String start() {
        return describe(List.of("a"));
    }

    public String describe(List<String> items) {
        return "items " + items.size();
    }
}
