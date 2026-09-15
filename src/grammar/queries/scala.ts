export const scala = `
(object_definition name: (identifier) @name) @definition.class
(class_definition name: (identifier) @name) @definition.class
(trait_definition name: (identifier) @name) @definition.trait
(function_definition name: (identifier) @name) @definition.method
(function_declaration name: (identifier) @name) @definition.method
(call_expression function: (identifier) @name) @reference.call
(call_expression function: (field_expression field: (identifier) @name)) @reference.call
`;
