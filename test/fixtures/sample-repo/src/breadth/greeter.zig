const Greeter = struct {
    pub fn greet(name: []const u8) []const u8 { return format(name); }
    fn format(name: []const u8) []const u8 { return name; }
};
pub fn run() []const u8 { return Greeter.greet("x"); }
