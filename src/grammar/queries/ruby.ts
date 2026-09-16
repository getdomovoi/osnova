export const ruby = `
(module name: (constant) @name) @definition.module
(class name: (constant) @name) @definition.class
(class body: (body_statement (method name: (identifier) @name) @definition.method))
(module body: (body_statement (method name: (identifier) @name) @definition.method))
(program (method name: (identifier) @name) @definition.function)
(singleton_method name: (identifier) @name) @definition.method
(call method: (identifier) @name) @reference.call
`;
