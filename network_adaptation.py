# network_adaptation.py
def evaluate_network(stats: dict):
    """
    Simple threshold-based network evaluation.
    Input 'stats' expected keys: rtt (ms), packetLoss (0-1), bandwidth (kbps)
    Returns one of: "normal", "degrade-video", "audio-only", "captions-only"
    """
    # default safe values
    rtt = float(stats.get("rtt", 0) or 0)
    loss = float(stats.get("packetLoss", 0) or 0)
    bw = float(stats.get("bandwidth", 1000) or 1000)

    # thresholds (tune these)
    if loss >= 0.20 or bw < 100:
        return "captions-only"
    if loss >= 0.10 or bw < 200:
        return "audio-only"
    if rtt >= 300 or loss >= 0.05 or bw < 400:
        return "degrade-video"
    return "normal"
