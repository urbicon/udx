// Bun bündelt diese Imports als Text (`with { type: 'text' }`).
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
