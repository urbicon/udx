// Bun bundles these imports as text (`with { type: 'text' }`).
declare module '*.toml' {
  const content: string;
  export default content;
}
declare module '*.sh' {
  const content: string;
  export default content;
}
declare module '*.tpl' {
  const content: string;
  export default content;
}
declare module '*.md' {
  const content: string;
  export default content;
}
