namespace geo {
class Shape {
 public:
  int area() { return width * height; }
  int width = 1;
  int height = 2;
};
}
int describe(geo::Shape& s) { return s.area(); }
int (*pick(int n))(int) { return 0; }
