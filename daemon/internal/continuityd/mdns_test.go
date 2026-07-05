package continuityd

import (
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestMDNSAdvertiserLifecycle(t *testing.T) {
	registration := &fakeMDNSRegistration{shutdown: make(chan struct{})}
	var registeredName string
	advertiser := &MDNSAdvertiser{
		register: func(name string, service string, domain string, port int, text []string) (mdnsRegistration, error) {
			registeredName = name
			if service != defaultMDNSService || domain != defaultMDNSDomain {
				t.Fatalf("unexpected service/domain: %s %s", service, domain)
			}
			if port != 19987 {
				t.Fatalf("unexpected port: %d", port)
			}
			return registration, nil
		},
	}
	name := "continuity-test-" + strings.ToLower(uuid.NewString())
	state, err := advertiser.Start(MDNSAdvertiseStartInput{
		Name:     name,
		Port:     19987,
		Endpoint: "tcp://test.local:19987",
		NodeID:   "test-node",
		Provider: "mdns",
		TXT: []string{
			"txtvers=1",
			"node=test-node",
			"endpoint=tcp://test.local:19987",
		},
		Now: "2026-07-05T14:40:00Z",
	})
	if err != nil {
		t.Fatalf("start advertiser: %v", err)
	}

	if !state.Running {
		t.Fatalf("expected running state")
	}
	if registeredName != name {
		t.Fatalf("unexpected registered name: %s", registeredName)
	}
	if state.Service != defaultMDNSService || state.Domain != defaultMDNSDomain {
		t.Fatalf("unexpected service/domain: %#v", state)
	}
	if _, err := advertiser.Start(MDNSAdvertiseStartInput{Name: name, Port: 19987}); err == nil {
		t.Fatalf("expected duplicate start to fail")
	}

	status := advertiser.Status()
	if !status.Running || status.Name != name {
		t.Fatalf("unexpected status: %#v", status)
	}
	stop := advertiser.Stop()
	if !stop.Stopped {
		t.Fatalf("expected stop to report stopped")
	}
	select {
	case <-registration.shutdown:
	case <-time.After(time.Second):
		t.Fatalf("expected registration shutdown")
	}
	if advertiser.Status().Running {
		t.Fatalf("expected stopped status")
	}
}

type fakeMDNSRegistration struct {
	shutdown chan struct{}
}

func (r *fakeMDNSRegistration) Shutdown() {
	close(r.shutdown)
}
