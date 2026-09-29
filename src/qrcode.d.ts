declare module "qrcode" {
  type QrColorOptions = {
    dark?: string;
    light?: string;
  };

  type QrDataUrlOptions = {
    width?: number;
    margin?: number;
    errorCorrectionLevel?: "L" | "M" | "Q" | "H";
    color?: QrColorOptions;
  };

  const QRCode: {
    toDataURL(text: string, options?: QrDataUrlOptions): Promise<string>;
  };

  export default QRCode;
}
