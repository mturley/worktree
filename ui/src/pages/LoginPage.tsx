import { useState, type FormEvent } from "react"
import { Alert, Button, Center, Paper, PasswordInput, Stack, Title } from "@mantine/core"
import { useQueryClient } from "@tanstack/react-query"
import { api } from "../api/client"

export function LoginPage() {
  const qc = useQueryClient()
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

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
