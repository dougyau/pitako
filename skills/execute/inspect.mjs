import "./loader.mjs";
const { inspect } = await import("./inspect.ts");
process.stdout.write(await inspect(process.argv.slice(2)));
