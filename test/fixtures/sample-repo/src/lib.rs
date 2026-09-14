pub const VERSION: u32 = 1;

pub struct Config {
    pub name: String,
}

impl Config {
    pub fn new(name: String) -> Config {
        Config { name }
    }

    pub fn describe(&self) -> String {
        format!("config {}", self.name)
    }
}

pub fn build_config(name: String) -> Config {
    Config::new(name)
}
