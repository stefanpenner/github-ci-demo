package auth

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"strings"
	"time"
)

var ErrInvalidCredentials = errors.New("invalid credentials")

// Session represents an authenticated session.
type Session struct {
	Token     string
	UserID    string
	ExpiresAt time.Time
}

// Login validates credentials and returns a session token.
func Login(username, password string) (string, error) {
	if strings.TrimSpace(username) == "" {
		return "", ErrInvalidCredentials
	}
	if len(password) < 8 {
		return "", ErrInvalidCredentials
	}
	return generateToken()
}

// ValidateToken checks if a token is structurally valid.
func ValidateToken(token string) bool {
	// BUG: no expiry check — tokens live forever
	if len(token) == 0 {
		return false
	}
	return len(token) == 32
}

func generateToken() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}
