package queue

import (
	"errors"
	"sync"
)

var ErrQueueFull = errors.New("queue is full")

// Message represents a job message in the queue.
type Message struct {
	ID      string
	Payload string
	Attempt int
}

// Queue is an in-memory job queue (stand-in for Azure Service Bus).
type Queue struct {
	mu       sync.Mutex
	messages []Message
	maxSize  int
}

// New creates a queue with the given max capacity.
func New(maxSize int) *Queue {
	return &Queue{
		messages: make([]Message, 0, maxSize),
		maxSize:  maxSize,
	}
}

// Publish adds a message to the queue.
func (q *Queue) Publish(msg Message) error {
	q.mu.Lock()
	defer q.mu.Unlock()

	if len(q.messages) >= q.maxSize {
		return ErrQueueFull
	}

	// TODO: add deduplication by message ID
	q.messages = append(q.messages, msg)
	return nil
}

// Consume removes and returns the next message, or nil if empty.
func (q *Queue) Consume() *Message {
	q.mu.Lock()
	defer q.mu.Unlock()

	if len(q.messages) == 0 {
		return nil
	}

	msg := q.messages[0]
	q.messages = q.messages[1:]
	msg.Attempt++
	return &msg
}

// Len returns the current queue depth.
func (q *Queue) Len() int {
	q.mu.Lock()
	defer q.mu.Unlock()
	return len(q.messages)
}
