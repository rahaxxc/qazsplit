// Vitest stand-in for the `server-only` marker. Next.js resolves `import "server-only"` itself
// (build error if a client module imports server code); tests only need the import to resolve.
export {};
