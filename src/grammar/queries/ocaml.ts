export const ocaml = `
(module_definition (module_binding (module_name) @name)) @definition.module
(value_definition (let_binding pattern: (value_name) @name)) @definition.function
(application_expression function: (value_path (value_name) @name)) @reference.call
`;
