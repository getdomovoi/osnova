use std::collections::HashMap;
use std::fmt::Display;

pub enum Mode {
    Fast,
    Slow,
}

pub trait Runner {
    fn name(&self) -> String;
    fn run(&self, v: u32) -> u32 {
        v * 2
    }
}

pub type Pair = (u32, u32);

pub fn scoped(s: &str) -> usize {
    let mut m: HashMap<&str, u32> = HashMap::new();
    m.insert(s, 1);
    s.len()
}

pub fn generic_call(v: u32) -> u32 {
    Vec::<u32>::new();
    v
}

pub fn with_display(d: &dyn Display) -> String {
    format!(\"{}\", d)
}
