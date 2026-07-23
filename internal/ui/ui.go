package ui

import (
	"bufio"
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/term"
)

const (
	ColorReset  = "\033[0m"
	ColorBold   = "\033[1m"
	ColorDim    = "\033[2m"
	ColorRed    = "\033[31m"
	ColorGreen  = "\033[32m"
	ColorYellow = "\033[33m"
	ColorBlue   = "\033[34m"
	ColorCyan   = "\033[36m"
)

func Bold(s string) string   { return ColorBold + s + ColorReset }
func Dim(s string) string    { return ColorDim + s + ColorReset }
func Red(s string) string    { return ColorRed + s + ColorReset }
func Green(s string) string  { return ColorGreen + s + ColorReset }
func Yellow(s string) string { return ColorYellow + s + ColorReset }
func Blue(s string) string   { return ColorBlue + s + ColorReset }
func Cyan(s string) string   { return ColorCyan + s + ColorReset }

func Confirm(prompt string) bool {
	fmt.Printf("%s [y/N] ", prompt)
	reader := bufio.NewReader(os.Stdin)
	line, _ := reader.ReadString('\n')
	line = strings.TrimSpace(strings.ToLower(line))
	return line == "y" || line == "yes"
}

func PromptChoice(prompt string, max int) (int, error) {
	fmt.Printf("%s: ", prompt)
	reader := bufio.NewReader(os.Stdin)
	line, _ := reader.ReadString('\n')
	line = strings.TrimSpace(line)
	n, err := strconv.Atoi(line)
	if err != nil || n < 1 || n > max {
		return 0, fmt.Errorf("invalid choice: %s", line)
	}
	return n, nil
}

func PromptLine(prompt string) string {
	fmt.Printf("%s: ", prompt)
	reader := bufio.NewReader(os.Stdin)
	line, _ := reader.ReadString('\n')
	return strings.TrimSpace(line)
}

func PromptLineDefault(prompt, defaultVal string) string {
	if defaultVal != "" {
		fmt.Printf("%s [%s]: ", prompt, defaultVal)
	} else {
		fmt.Printf("%s: ", prompt)
	}
	reader := bufio.NewReader(os.Stdin)
	line, _ := reader.ReadString('\n')
	line = strings.TrimSpace(line)
	if line == "" {
		return defaultVal
	}
	return line
}

func PromptSecret(prompt string) string {
	fmt.Printf("%s: ", prompt)
	b, err := term.ReadPassword(int(os.Stdin.Fd()))
	fmt.Println()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

type Spinner struct {
	message string
	stop    chan struct{}
	done    sync.WaitGroup
}

var spinnerFrames = []string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"}

func StartSpinner(message string) *Spinner {
	s := &Spinner{
		message: message,
		stop:    make(chan struct{}),
	}
	s.done.Add(1)
	go func() {
		defer s.done.Done()
		i := 0
		for {
			select {
			case <-s.stop:
				fmt.Printf("\r\033[K")
				return
			default:
				fmt.Printf("\r  %s %s", Dim(spinnerFrames[i%len(spinnerFrames)]), s.message)
				i++
				time.Sleep(80 * time.Millisecond)
			}
		}
	}()
	return s
}

func (s *Spinner) Stop(result string) {
	close(s.stop)
	s.done.Wait()
	if result != "" {
		fmt.Println(result)
	}
}

func SpinWhile(message string, fn func() error) error {
	s := StartSpinner(message)
	err := fn()
	if err != nil {
		s.Stop(fmt.Sprintf("  %s %s: %v", Red("✗"), message, err))
	} else {
		s.Stop(fmt.Sprintf("  %s %s", Green("✓"), message))
	}
	return err
}

func ShortPath(path string) string {
	home, err := os.UserHomeDir()
	if err != nil {
		return path
	}
	if strings.HasPrefix(path, home) {
		return "~" + path[len(home):]
	}
	return path
}
