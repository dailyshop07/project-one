/**
 * Trystero keeps a pool of initiator RTCPeerConnections ready for discovery.
 * When an unanswered pooled offer becomes old, the current Trystero release
 * ICE-restarts it. Safari and Chromium can then return an offer with no ICE
 * candidates, leaving both peers permanently in "connecting".
 *
 * For an offer that has never received a remote description, its original
 * candidates are still valid. Preserve that offer instead of restarting ICE.
 * This is the workaround described by the upstream Trystero issue for this
 * failure mode.
 */
export class KeepPristineOfferPeerConnection extends RTCPeerConnection {
  constructor(configuration?: RTCConfiguration) {
    super(configuration);
    let preservePristineOffer = false;
    const originalSetLocalDescription = this.setLocalDescription.bind(this);
    const originalRestartIce = this.restartIce.bind(this);
    const originalCreateOffer = this.createOffer.bind(this);

    this.setLocalDescription = ((description?: RTCLocalSessionDescriptionInit) => {
      const pristineOffer = !this.remoteDescription && this.localDescription?.type === "offer";
      if (description?.type === "rollback" && pristineOffer) {
        preservePristineOffer = true;
        return Promise.resolve();
      }
      if (preservePristineOffer && description?.type === "offer") {
        preservePristineOffer = false;
        return Promise.resolve();
      }
      preservePristineOffer = false;
      return originalSetLocalDescription(description);
    }) as RTCPeerConnection["setLocalDescription"];

    this.restartIce = (() => {
      if (!preservePristineOffer) originalRestartIce();
    }) as RTCPeerConnection["restartIce"];

    this.createOffer = ((options?: RTCOfferOptions) => {
      if (preservePristineOffer && this.localDescription?.type === "offer") {
        return Promise.resolve({
          type: "offer",
          sdp: this.localDescription.sdp,
        });
      }
      return originalCreateOffer(options);
    }) as RTCPeerConnection["createOffer"];
  }
}
