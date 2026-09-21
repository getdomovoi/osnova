#import <Foundation/Foundation.h>

typedef struct { int x; int y; } Point;

enum Mode { FAST, SLOW };

@protocol Named
- (NSString *)name;
@end

@interface Greeter : NSObject <Named>
@property (nonatomic, copy) NSString *prefix;
- (NSString *)greet:(NSString *)name;
- (NSString *)formatName:(NSString *)name with:(NSString *)prefix;
+ (instancetype)shared;
@end

@implementation Greeter
- (NSString *)greet:(NSString *)name {
  return [self formatName:name with:self.prefix];
}
- (NSString *)formatName:(NSString *)name with:(NSString *)prefix {
  return [NSString stringWithFormat:@"%@ %@", prefix, [name uppercaseString]];
}
+ (instancetype)shared {
  return [[Greeter alloc] init];
}
- (NSString *)name {
  return @"greeter";
}
@end

static int helper(int v) {
  return v + 1;
}

int run(void) {
  Greeter *g = [Greeter shared];
  NSLog(@"%@", [g greet:@"x"]);
  return helper(2);
}
