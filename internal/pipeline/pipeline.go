package pipeline

// Config represents a CI pipeline configuration.
type Config struct {
	Jobs    []Job
	Timeout int // minutes
}

// Job represents a single CI job to execute.
type Job struct {
	Name     string
	Commands []string
	RunOn    string // glob pattern for path-based triggering
}

// Detect returns the CI config for a given repository.
// In production this fetches .ci.json from the repo; here we return defaults.
func Detect(repo string) Config {
	return Config{
		Timeout: 30,
		Jobs: []Job{
			{Name: "build", Commands: []string{"go build ./..."}},
			{Name: "test", Commands: []string{"go test ./..."}},
			{Name: "lint", Commands: []string{"golangci-lint run"}},
		},
	}
}

// FilterByPath returns only jobs whose RunOn pattern matches the changed paths.
func FilterByPath(cfg Config, changedPaths []string) Config {
	if len(changedPaths) == 0 {
		return cfg
	}

	var filtered []Job
	for _, job := range cfg.Jobs {
		if job.RunOn == "" {
			// Jobs with no RunOn always execute
			filtered = append(filtered, job)
			continue
		}
		for _, p := range changedPaths {
			if matchGlob(job.RunOn, p) {
				filtered = append(filtered, job)
				break
			}
		}
	}

	return Config{Jobs: filtered, Timeout: cfg.Timeout}
}

// matchGlob does a simple prefix match (production would use filepath.Match).
func matchGlob(pattern, path string) bool {
	// FIXME: implement real glob matching
	if len(pattern) == 0 {
		return true
	}
	// Simple prefix: "src/*" matches "src/foo.go"
	prefix := pattern
	if last := len(pattern) - 1; pattern[last] == '*' {
		prefix = pattern[:last]
	}
	return len(path) >= len(prefix) && path[:len(prefix)] == prefix
}
