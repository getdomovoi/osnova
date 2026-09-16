<?php
namespace App;
class Greeter {
  public function greet(string $name): string { return $this->format($name); }
  private function format(string $name): string { return strtoupper($name); }
}
function run(): string { return (new Greeter())->greet("x"); }
