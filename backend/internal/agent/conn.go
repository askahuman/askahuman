package agent

import (
	"context"
	"fmt"
	"net/http"

	"github.com/coder/websocket"
)

// frameConn is the narrow transport the agent depends on: it reads and
// writes single JSON text frames and closes. The relay's WebSocket
// satisfies it; unit tests supply a fake to exercise retry/timeout.
type frameConn interface {
	// readFrame blocks for the next text frame, returning its raw bytes.
	readFrame(ctx context.Context) ([]byte, error)
	// writeFrame sends raw bytes as one text frame.
	writeFrame(ctx context.Context, data []byte) error
	// close tears down the connection.
	close() error
}

// dialer opens a frameConn to a relay room. The default dials a real
// WebSocket; tests inject a fake.
type dialer func(ctx context.Context, relayURL, roomID string) (frameConn, error)

// wsConn adapts a coder/websocket connection to frameConn.
type wsConn struct {
	c *websocket.Conn
}

func (w *wsConn) readFrame(ctx context.Context) ([]byte, error) {
	typ, data, err := w.c.Read(ctx)
	if err != nil {
		return nil, err
	}
	if typ != websocket.MessageText {
		// App and relay frames are JSON text; skip anything else.
		return w.readFrame(ctx)
	}
	return data, nil
}

func (w *wsConn) writeFrame(ctx context.Context, data []byte) error {
	return w.c.Write(ctx, websocket.MessageText, data)
}

func (w *wsConn) close() error { return w.c.Close(websocket.StatusNormalClosure, "") }

// dialWS dials the relay at relayURL joining roomID and returns a frameConn.
func dialWS(ctx context.Context, relayURL, roomID string) (frameConn, error) {
	u := fmt.Sprintf("%s?room=%s", relayURL, roomID)
	//nolint:bodyclose // successful 101 upgrade: coder/websocket owns the response; only the error path has a body to close.
	c, _, err := websocket.Dial(ctx, u, &websocket.DialOptions{HTTPClient: http.DefaultClient})
	if err != nil {
		return nil, fmt.Errorf("agent: dial %s: %w", relayURL, err)
	}
	// Approval payloads are tiny; the default 32KiB read limit is plenty.
	return &wsConn{c: c}, nil
}
