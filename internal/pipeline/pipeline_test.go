package pipeline

import (
	"testing"
)

func TestDetectReturnsDefaults(t *testing.T) {
	cfg := Detect("acme/api")
	if len(cfg.Jobs) != 3 {
		t.Errorf("expected 3 default jobs, got %d", len(cfg.Jobs))
	}
	if cfg.Timeout != 30 {
		t.Errorf("expected timeout 30, got %d", cfg.Timeout)
	}
}

func TestDetectJobNames(t *testing.T) {
	cfg := Detect("acme/api")
	expected := []string{"build", "test", "lint"}
	for i, job := range cfg.Jobs {
		if job.Name != expected[i] {
			t.Errorf("job %d: expected name %q, got %q", i, expected[i], job.Name)
		}
	}
}

func TestFilterByPathNoFilter(t *testing.T) {
	cfg := Detect("acme/api")
	filtered := FilterByPath(cfg, nil)
	if len(filtered.Jobs) != len(cfg.Jobs) {
		t.Errorf("expected all jobs when no paths, got %d", len(filtered.Jobs))
	}
}

func TestFilterByPathWithRunOn(t *testing.T) {
	cfg := Config{
		Timeout: 10,
		Jobs: []Job{
			{Name: "frontend", RunOn: "web/*", Commands: []string{"npm test"}},
			{Name: "backend", RunOn: "api/*", Commands: []string{"go test ./..."}},
			{Name: "lint", Commands: []string{"lint"}}, // no RunOn = always runs
		},
	}

	filtered := FilterByPath(cfg, []string{"api/handler.go"})
	if len(filtered.Jobs) != 2 {
		t.Errorf("expected 2 jobs (backend + lint), got %d", len(filtered.Jobs))
	}

	names := make(map[string]bool)
	for _, j := range filtered.Jobs {
		names[j.Name] = true
	}
	if !names["backend"] {
		t.Error("expected backend job to be included")
	}
	if !names["lint"] {
		t.Error("expected lint job to be included")
	}
	if names["frontend"] {
		t.Error("expected frontend job to be excluded")
	}
}

func TestMatchGlob(t *testing.T) {
	tests := []struct {
		pattern string
		path    string
		want    bool
	}{
		{"src/*", "src/foo.go", true},
		{"src/*", "lib/bar.go", false},
		{"", "anything", true},
		{"api/*", "api/handler.go", true},
		{"api/*", "web/index.html", false},
	}

	for _, tt := range tests {
		t.Run(tt.pattern+"→"+tt.path, func(t *testing.T) {
			if got := matchGlob(tt.pattern, tt.path); got != tt.want {
				t.Errorf("matchGlob(%q, %q) = %v, want %v", tt.pattern, tt.path, got, tt.want)
			}
		})
	}
}
