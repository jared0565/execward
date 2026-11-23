/** Wrangler bundles a `.sql` file as its text. */
declare module "*.sql" {
  const text: string;
  export default text;
}
