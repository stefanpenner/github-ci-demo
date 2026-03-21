package main

import (
	"fmt"
	"log"
	"net/http"

	"github.com/stefanpenner/github-ci-demo/internal/auth"
	"github.com/stefanpenner/github-ci-demo/internal/pipeline"
)

func main() {
	mux := http.NewServeMux()

	mux.HandleFunc("POST /login", func(w http.ResponseWriter, r *http.Request) {
		username := r.FormValue("username")
		password := r.FormValue("password")

		token, err := auth.Login(username, password)
		if err != nil {
			http.Error(w, err.Error(), http.StatusUnauthorized)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"token":%q}`, token)
	})

	mux.HandleFunc("GET /pipeline/{repo}", func(w http.ResponseWriter, r *http.Request) {
		repo := r.PathValue("repo")
		cfg := pipeline.Detect(repo)

		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"repo":%q,"jobs":%d,"timeout":%d}`, repo, len(cfg.Jobs), cfg.Timeout)
	})

	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		fmt.Fprint(w, "ok")
	})

	log.Println("listening on :8080")
	log.Fatal(http.ListenAndServe(":8080", mux))
}
