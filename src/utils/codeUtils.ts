export function generateRandomCode(): string {
    const timestamp = Date.now().toString(36);
    const randomPart = Math.random().toString(36).slice(2, 12);
    const code = (timestamp + randomPart).toUpperCase().slice(0, 20);
    return code;
}

export function buildPoUrl(fileId: string, code: string, baseUrl: string = 'https://nds.nusa.net.id'): string {
    const url = new URL(baseUrl);
    url.searchParams.set('id', fileId);
    url.searchParams.set('code', code);
    url.searchParams.set('type', 'po');
    url.searchParams.set('stempelSigner', 'FALSE');
    return url.toString();
}