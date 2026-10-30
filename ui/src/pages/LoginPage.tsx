import { useEffect, useState, type FormEvent } from "react"
import { Alert, Button, Center, Code, Paper, PasswordInput, Stack, Title } from "@mantine/core"
import { useQueryClient } from "@tanstack/react-query"
import { api } from "../api/client"
import { postToMac } from "../lib/macBridge"

export function LoginPage() {
  const qc = useQueryClient()
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  // Lets the macOS app show its logged-out state.
  useEffect(() => postToMac({ type: "login" }), [])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!password) return
    setSubmitting(true)
    setError(null)
    try {
      await api.login(password)
      // Everything cached while logged out is a refusal; start clean. This
      // also refetches the session, which lets the app through.
      await qc.resetQueries()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed")
      setSubmitting(false)
    }
  }

  return (
    <Center mih="100vh" p="md">
      <Paper withBorder p="lg" w={340} maw="100%">
        <form onSubmit={submit}>
          <Stack gap="md">
            <Title order={3}>worktree</Title>
            <PasswordInput
              label="Password"
              // Where to find it: setup prints it only once, when it generates it.
              description={
                <>
                  It&apos;s <Code>ui.password</Code> in <Code>~/.config/worktree/config.yaml</Code> on
                  the machine running <Code>worktree ui</Code>.
                </>
              }
              value={password}
              onChange={(e) => setPassword(e.currentTarget.value)}
              autoFocus
              autoComplete="current-password"
            />
            {error && <Alert color="red" title="Couldn't log in">{error}</Alert>}
            <Button type="submit" loading={submitting} disabled={!password}>Log in</Button>
          </Stack>
        </form>
      </Paper>
    </Center>
  )
}
