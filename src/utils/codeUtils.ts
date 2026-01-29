export function generateRandomCode(): string {
    const timestamp = Date.now().toString(36);
    const randomPart = Math.random().toString(36).slice(2, 12);
    const code = (timestamp + randomPart).toUpperCase().slice(0, 20);
    return code;
}

export function buildPoUrl(fileId: string, code: string, useStempel: boolean = false, baseUrl: string = 'https://nds.nusa.net.id'): string {
    const url = new URL(baseUrl);
    url.searchParams.set('id', fileId);
    url.searchParams.set('code', code);
    url.searchParams.set('type', 'po');
    url.searchParams.set('stempelSigner', useStempel ? 'TRUE' : 'FALSE');
    return url.toString();
}

export function getGreeting() {
    const currentHour = new Date().getHours(); // Get the current hour (0-23)

    if (currentHour >= 5 && currentHour < 11) {
        return "Pagi!";  // Morning (5 AM to 10:59 AM)
    } else if (currentHour >= 11 && currentHour < 15) {
        return "Siang!"; // Afternoon (11 AM to 2:59 PM)
    } else if (currentHour >= 15 && currentHour < 18) {
        return "Sore!";  // Evening (3 PM to 5:59 PM)
    } else {
        return "Malam!"; // Night (6 PM to 4:59 AM)
    }
}