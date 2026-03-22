package queue

import (
	"sync"
	"testing"
)

func TestPublishAndConsume(t *testing.T) {
	q := New(10)

	err := q.Publish(Message{ID: "1", Payload: "job-1"})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	msg := q.Consume()
	if msg == nil {
		t.Fatal("expected a message, got nil")
	}
	if msg.ID != "1" {
		t.Errorf("expected ID '1', got %q", msg.ID)
	}
	if msg.Attempt != 1 {
		t.Errorf("expected attempt 1, got %d", msg.Attempt)
	}
}

func TestConsumeEmpty(t *testing.T) {
	q := New(10)
	msg := q.Consume()
	if msg != nil {
		t.Errorf("expected nil from empty queue, got %v", msg)
	}
}

func TestQueueFull(t *testing.T) {
	q := New(2)

	_ = q.Publish(Message{ID: "1", Payload: "a"})
	_ = q.Publish(Message{ID: "2", Payload: "b"})

	err := q.Publish(Message{ID: "3", Payload: "c"})
	if err != ErrQueueFull {
		t.Errorf("expected ErrQueueFull, got %v", err)
	}
}

func TestQueueLen(t *testing.T) {
	q := New(10)
	if q.Len() != 0 {
		t.Errorf("expected len 0, got %d", q.Len())
	}

	_ = q.Publish(Message{ID: "1", Payload: "a"})
	_ = q.Publish(Message{ID: "2", Payload: "b"})
	if q.Len() != 2 {
		t.Errorf("expected len 2, got %d", q.Len())
	}

	q.Consume()
	if q.Len() != 1 {
		t.Errorf("expected len 1, got %d", q.Len())
	}
}

func TestConcurrentAccess(t *testing.T) {
	q := New(1000)

	var wg sync.WaitGroup
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			_ = q.Publish(Message{ID: string(rune(id)), Payload: "data"})
		}(i)
	}
	wg.Wait()

	if q.Len() != 100 {
		t.Errorf("expected 100 messages after concurrent publish, got %d", q.Len())
	}
}

func TestFIFOOrder(t *testing.T) {
	q := New(10)
	_ = q.Publish(Message{ID: "first", Payload: "1"})
	_ = q.Publish(Message{ID: "second", Payload: "2"})
	_ = q.Publish(Message{ID: "third", Payload: "3"})

	msg := q.Consume()
	if msg.ID != "first" {
		t.Errorf("expected first message, got %q", msg.ID)
	}
	msg = q.Consume()
	if msg.ID != "second" {
		t.Errorf("expected second message, got %q", msg.ID)
	}
}
