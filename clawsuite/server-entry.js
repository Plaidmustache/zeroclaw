import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { join, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, default as WebSocket } from 'ws'
import server from './dist/server/server.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const CLIENT_DIR = join(__dirname, 'dist', 'client')

const port = parseInt(process.env.PORT || '3000', 10)
const host = process.env.HOST || '0.0.0.0'

const MIME_TYPES = {
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.html': 'text/html',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.map': 'application/json',
  '.txt': 'text/plain',
  '.xml': 'application/xml',
  '.webmanifest': 'application/manifest+json',
}

async function tryServeStatic(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
  const pathname = decodeURIComponent(url.pathname)

  // Prevent directory traversal
  if (pathname.includes('..')) return false

  const filePath = join(CLIENT_DIR, pathname)

  // Make sure the resolved path is within CLIENT_DIR
  if (!filePath.startsWith(CLIENT_DIR)) return false

  try {
    const fileStat = await stat(filePath)
    if (!fileStat.isFile()) return false

    const ext = extname(filePath).toLowerCase()
    const contentType = MIME_TYPES[ext] || 'application/octet-stream'
    const data = await readFile(filePath)

    const headers = {
      'Content-Type': contentType,
      'Content-Length': data.length,
    }

    // Cache hashed assets aggressively (they have content hashes in filenames)
    if (pathname.startsWith('/assets/')) {
      headers['Cache-Control'] = 'public, max-age=31536000, immutable'
    }

    res.writeHead(200, headers)
    res.end(data)
    return true
  } catch {
    return false
  }
}

const httpServer = createServer(async (req, res) => {
  // Try static files first (client assets)
  if (req.method === 'GET' || req.method === 'HEAD') {
    const served = await tryServeStatic(req, res)
    if (served) return
  }

  // Fall through to SSR handler
  const url = new URL(
    req.url || '/',
    `http://${req.headers.host || 'localhost'}`,
  )

  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (value) headers.set(key, Array.isArray(value) ? value.join(', ') : value)
  }

  let body = null
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    body = await new Promise((resolve) => {
      const chunks = []
      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', () => resolve(Buffer.concat(chunks)))
    })
  }

  const request = new Request(url.toString(), {
    method: req.method,
    headers,
    body,
    duplex: 'half',
  })

  try {
    const response = await server.fetch(request)

    res.writeHead(
      response.status,
      Object.fromEntries(response.headers.entries()),
    )

    if (response.body) {
      const reader = response.body.getReader()
      const pump = async () => {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          res.write(value)
        }
        res.end()
      }
      pump().catch((err) => {
        console.error('Stream error:', err)
        res.end()
      })
    } else {
      const text = await response.text()
      res.end(text)
    }
  } catch (err) {
    console.error('Request error:', err)
    res.writeHead(500)
    res.end('Internal Server Error')
  }
})

// WebSocket proxy for /ws-gateway
const wsGatewayServer = new WebSocketServer({ noServer: true })

httpServer.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
  if (url.pathname !== '/ws-gateway') {
    return
  }

  wsGatewayServer.handleUpgrade(req, socket, head, (clientWs) => {
    const upstreamUrl = (process.env.CLAWDBOT_GATEWAY_URL || 'ws://127.0.0.1:18789').trim()
    const token = (process.env.CLAWDBOT_GATEWAY_TOKEN || '').trim()
    const headers = token ? { Authorization: `Bearer ${token}` } : undefined

    console.log(`[ws-gateway] proxying to ${upstreamUrl}`)

    const upstreamWs = new WebSocket(upstreamUrl, headers ? { headers } : undefined)

    const closeBoth = () => {
      if (clientWs.readyState !== WebSocket.CLOSED && clientWs.readyState !== WebSocket.CLOSING) {
        if (typeof clientWs.terminate === 'function') clientWs.terminate()
        else clientWs.close()
      }
      if (upstreamWs.readyState !== WebSocket.CLOSED && upstreamWs.readyState !== WebSocket.CLOSING) {
        if (typeof upstreamWs.terminate === 'function') upstreamWs.terminate()
        else upstreamWs.close()
      }
    }

    // Forward messages from client to upstream
    clientWs.on('message', (data, isBinary) => {
      if (upstreamWs.readyState === WebSocket.OPEN) {
        upstreamWs.send(data, { binary: isBinary })
      }
    })

    // Forward messages from upstream to client
    upstreamWs.on('message', (data, isBinary) => {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(data, { binary: isBinary })
      }
    })

    // Close both sockets when either side closes
    clientWs.on('close', closeBoth)
    upstreamWs.on('close', closeBoth)

    // Handle errors
    clientWs.on('error', (err) => {
      console.error('[ws-gateway] client error:', err.message)
      closeBoth()
    })
    upstreamWs.on('error', (err) => {
      console.error('[ws-gateway] upstream error:', err.message)
      closeBoth()
    })
  })
})

httpServer.listen(port, host, () => {
  console.log(`ClawSuite running at http://${host}:${port}`)
})
