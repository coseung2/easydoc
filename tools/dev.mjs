import concurrently from 'concurrently'

const editors = ['docs', 'sheets', 'slides', 'pdf', 'markdown']
const rendererUrls = Object.fromEntries(
  editors.map((name, index) => [
    `${name.toUpperCase()}_RENDERER_URL`,
    `http://localhost:${5173 + index}`,
  ]),
)

// Pass environment variables directly so Windows and POSIX use the same launcher.
const { result } = concurrently(
  [
    ...editors.map((name) => ({
      name,
      command: `npm run dev:renderer -w @genoffice/${name}`,
    })),
    { name: 'shell', command: 'npm run dev -w @genoffice/shell', env: rendererUrls },
  ],
  {
    prefix: 'name',
    prefixColors: ['blue', 'green', 'yellow', 'red', 'cyan', 'magenta'],
    killOthersOn: ['success', 'failure'],
  },
)

try {
  await result
} catch {
  process.exitCode = 1
}
