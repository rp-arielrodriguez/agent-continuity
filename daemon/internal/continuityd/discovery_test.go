package continuityd

import (
	"testing"
)

func TestDiscoverTailscalePeersUsesExplicitTrustAndOverlayIP(t *testing.T) {
	input := PeerDiscoverInput{
		Port:         9987,
		TrustedNames: []string{"workstation"},
	}
	data := []byte(`{
		"Peer": {
			"node-trusted": {
				"ID": "ts-trusted-id",
				"HostName": "workstation",
				"DNSName": "workstation.tailnet.example.ts.net.",
				"TailscaleIPs": ["100.64.0.2", "fd7a:115c:a1e0::2"],
				"Online": true
			},
			"node-untrusted": {
				"HostName": "other",
				"DNSName": "other.tailnet.example.ts.net.",
				"TailscaleIPs": ["100.64.0.3"],
				"Online": true
			}
		}
	}`)

	peers, warnings, err := DiscoverTailscalePeers(data, input)
	if err != nil {
		t.Fatal(err)
	}
	if len(warnings) != 0 {
		t.Fatalf("warnings = %+v, want none", warnings)
	}
	if len(peers) != 1 {
		t.Fatalf("peers = %+v, want one trusted peer", peers)
	}
	if peers[0].Endpoint != "tcp://100.64.0.2:9987" {
		t.Fatalf("endpoint = %s", peers[0].Endpoint)
	}
	if peers[0].NodeID != "ts-trusted-id" {
		t.Fatalf("node id = %s", peers[0].NodeID)
	}
}

func TestDiscoverTailscalePeersWarnsForOfflineTrustedPeer(t *testing.T) {
	input := PeerDiscoverInput{
		Port:           9987,
		TrustedNodeIDs: []string{"node-offline"},
	}
	data := []byte(`{
		"Peer": {
			"node-offline": {
				"HostName": "offline-workstation",
				"DNSName": "offline-workstation.tailnet.example.ts.net.",
				"TailscaleIPs": ["100.64.0.4"],
				"Online": false
			}
		}
	}`)

	peers, warnings, err := DiscoverTailscalePeers(data, input)
	if err != nil {
		t.Fatal(err)
	}
	if len(peers) != 0 {
		t.Fatalf("peers = %+v, want none", peers)
	}
	if len(warnings) != 1 {
		t.Fatalf("warnings = %+v, want one offline warning", warnings)
	}
}

func TestDiscoverZeroTierPeersUsesTrustedNodePathAddress(t *testing.T) {
	input := PeerDiscoverInput{
		Port:           9987,
		TrustedNodeIDs: []string{"abcdef1234"},
	}
	data := []byte(`[
		{
			"address": "abcdef1234",
			"paths": [{"address": "10.10.0.5/9993"}]
		},
		{
			"address": "0000000000",
			"paths": [{"address": "10.10.0.6/9993"}]
		}
	]`)

	peers, warnings, err := DiscoverZeroTierPeers(data, input)
	if err != nil {
		t.Fatal(err)
	}
	if len(warnings) != 0 {
		t.Fatalf("warnings = %+v, want none", warnings)
	}
	if len(peers) != 1 {
		t.Fatalf("peers = %+v, want one trusted peer", peers)
	}
	if peers[0].Endpoint != "tcp://10.10.0.5:9987" {
		t.Fatalf("endpoint = %s", peers[0].Endpoint)
	}
}

func TestDiscoverPeersRequiresExplicitTrust(t *testing.T) {
	_, err := DiscoverPeers(t.Context(), PeerDiscoverInput{Port: 9987, Providers: []string{"tailscale"}})
	if err == nil {
		t.Fatal("expected explicit trust validation error")
	}
}

func TestTCPEndpointFormatsIPv6(t *testing.T) {
	if got := tcpEndpoint("fd7a:115c:a1e0::2", 9987); got != "tcp://[fd7a:115c:a1e0::2]:9987" {
		t.Fatalf("tcpEndpoint() = %s", got)
	}
}
