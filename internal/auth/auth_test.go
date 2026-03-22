package auth

import (
	"testing"
)

func TestLoginSuccess(t *testing.T) {
	token, err := Login("alice", "supersecret123")
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if len(token) != 32 {
		t.Errorf("expected 32-char token, got %d chars", len(token))
	}
}

func TestLoginEmptyUsername(t *testing.T) {
	_, err := Login("", "password123")
	if err != ErrInvalidCredentials {
		t.Errorf("expected ErrInvalidCredentials, got %v", err)
	}
}

func TestLoginShortPassword(t *testing.T) {
	_, err := Login("alice", "short")
	if err != ErrInvalidCredentials {
		t.Errorf("expected ErrInvalidCredentials, got %v", err)
	}
}

func TestValidateToken(t *testing.T) {
	tests := []struct {
		name  string
		token string
		want  bool
	}{
		{"empty", "", false},
		{"too short", "abc123", false},
		{"valid length", "abcdef0123456789abcdef0123456789", true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := ValidateToken(tt.token); got != tt.want {
				t.Errorf("ValidateToken(%q) = %v, want %v", tt.token, got, tt.want)
			}
		})
	}
}
