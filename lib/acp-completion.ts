import { spawn } from 'child_process'

interface JsonRpcMessage {
  jsonrpc: '2.0'
  id?: number
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: { code?: number; message?: string }
}

interface AcpPromptOptions {
  command: string
  args: string[]
  prompt: string
  authMethodId?: string
  mode?: 'agent' | 'plan' | 'ask'
  timeoutMs?: number
  model?: string
  maxTokens?: number
}

function parseLine(line: string): JsonRpcMessage | null {
  try {
    return JSON.parse(line) as JsonRpcMessage
  } catch {
    return null
  }
}

function asErrorMessage(msg: JsonRpcMessage): string {
  if (msg.error?.message) return msg.error.message
  return 'Unknown ACP error'
}

export async function acpPrompt(options: AcpPromptOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(options.command, options.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
      windowsHide: true,
    })

    let nextId = 1
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>()
    let outBuffer = ''
    let stderr = ''
    let streamedText = ''

    const timer = setTimeout(() => {
      for (const waiter of pending.values()) waiter.reject(new Error('ACP request timed out'))
      pending.clear()
      proc.kill()
      reject(new Error(`ACP request timed out after ${options.timeoutMs ?? 120_000}ms`))
    }, options.timeoutMs ?? 120_000)

    const cleanup = () => {
      clearTimeout(timer)
      try { proc.kill() } catch { /* ignore */ }
    }

    const send = (method: string, params: Record<string, unknown>) => {
      const id = nextId++
      const payload: JsonRpcMessage = { jsonrpc: '2.0', id, method, params }
      proc.stdin.write(`${JSON.stringify(payload)}\n`)
      return new Promise<unknown>((resolveCall, rejectCall) => {
        pending.set(id, { resolve: resolveCall, reject: rejectCall })
      })
    }

    const respond = (id: number, result: unknown) => {
      const payload: JsonRpcMessage = { jsonrpc: '2.0', id, result }
      proc.stdin.write(`${JSON.stringify(payload)}\n`)
    }

    const onJsonMessage = (msg: JsonRpcMessage) => {
      if (typeof msg.id === 'number' && (msg.result !== undefined || msg.error)) {
        const waiter = pending.get(msg.id)
        if (!waiter) return
        pending.delete(msg.id)
        if (msg.error) waiter.reject(new Error(asErrorMessage(msg)))
        else waiter.resolve(msg.result)
        return
      }

      if (msg.method === 'session/update') {
        const update = msg.params?.update as { sessionUpdate?: string; content?: { text?: string } } | undefined
        if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.text) {
          streamedText += update.content.text
        }
        return
      }

      if (msg.method === 'session/request_permission' && typeof msg.id === 'number') {
        // Security default for unattended server paths: deny tool execution.
        respond(msg.id, { outcome: { outcome: 'selected', optionId: 'reject-once' } })
      }
    }

    proc.stdout.on('data', (chunk: Buffer) => {
      outBuffer += chunk.toString('utf8')
      let idx = outBuffer.indexOf('\n')
      while (idx !== -1) {
        const line = outBuffer.slice(0, idx).trim()
        outBuffer = outBuffer.slice(idx + 1)
        if (line) {
          const msg = parseLine(line)
          if (msg) onJsonMessage(msg)
        }
        idx = outBuffer.indexOf('\n')
      }
    })

    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })

    proc.on('error', (err) => {
      cleanup()
      reject(err)
    })

    proc.on('close', (code) => {
      if (pending.size > 0) {
        for (const waiter of pending.values()) waiter.reject(new Error(`ACP process exited early (${code})`))
        pending.clear()
      }
    })

    void (async () => {
      try {
        await send('initialize', {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: { name: 'siftly-acp-client', version: '0.1.0' },
        })

        if (options.authMethodId) {
          await send('authenticate', { methodId: options.authMethodId })
        }

        const sessionNew = await send('session/new', {
          cwd: process.cwd(),
          mode: options.mode ?? 'ask',
          mcpServers: [],
        }) as { sessionId?: string }

        if (!sessionNew?.sessionId) {
          throw new Error('ACP session/new did not return sessionId')
        }

        await send('session/prompt', {
          sessionId: sessionNew.sessionId,
          model: options.model,
          maxTokens: options.maxTokens,
          prompt: [{ type: 'text', text: options.prompt }],
        })

        cleanup()
        const finalText = streamedText.trim()
        if (finalText) {
          resolve(finalText)
          return
        }
        if (stderr.trim()) {
          reject(new Error(`ACP produced no text output: ${stderr.trim().slice(0, 220)}`))
          return
        }
        resolve('')
      } catch (err) {
        cleanup()
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })()
  })
}
