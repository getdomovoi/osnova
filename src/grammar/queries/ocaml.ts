export const ocaml = `
(value_definition (let_binding pattern: (value_name) @name)) @definition.function
(application_expression function: (value_path (value_name) @name)) @reference.call
`;
