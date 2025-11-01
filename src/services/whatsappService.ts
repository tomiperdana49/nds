import axios from 'axios';

export async function sendHsmMeta(phoneNumber: string, params: any, nameDoc: any, namaPic: any): Promise<any> {
    try {
        const phone_number_id = process.env.NWA_PHONE_NUMBER_ID!;
        const apiUrl = `https://nwc.nusa.net.id/api/messages?phone_number_id=${phone_number_id}&no_save=1`;

        const headers = {
            'Content-Type': 'application/json',
            'X-Api-Key': process.env.NWA_ACCESS_KEY!,
        };

        const requestBody = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: phoneNumber,
            type: 'template',
            template: {
                namespace: '47d9dc76_80fc_4c77_95f5_869dfeb41766',
                name: 'docs_auto_generation_nusanet_v3',
                language: {
                    code: 'id',
                },
                components: [
                    {
                        type: 'body',
                        parameters: [
                            {
                                type: 'text',
                                text: params,
                            },
                            {
                                type: 'text',
                                text: nameDoc,
                            },
                            {
                                type: 'text',
                                text: namaPic,
                            }
                        ],
                    },
                ],
            },
        };

        const response = await axios.post(apiUrl, requestBody, { headers });

        return response.data;
    } catch (error) {
        if (error instanceof Error) {
            console.error('Error:', error.message);
            throw error;
        } else {
            console.error('Unknown error occurred:', error);
            throw new Error('An unknown error occurred');
        }
    }
}

export async function sendToWhatsappInternal(phoneNumber: string, params: any): Promise<any> {
    try {
        const url = "https://socket1.nusacontact.com/waenq/v2/messages";
        const payload = {
            body: "text",
            to: phoneNumber,
            text: params,
        };
        const headers = {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + process.env.WA_BEARER_KEY!,
        };

        const response = await axios.post(url, payload, { headers });

        return response.data;
    } catch (error) {
        if (error instanceof Error) {
            console.error('Error:', error.message);
            throw error;
        } else {
            console.error('Unknown error occurred:', error);
            throw new Error('An unknown error occurred');
        }
    }
}

export async function sendHsmMetaMesaageLink(phoneNumber: string, body: any): Promise<any> {
    try {
        const phone_number_id = process.env.NWA_PHONE_NUMBER_ID!;
        const apiUrl = `https://nwc.nusa.net.id/api/messages?phone_number_id=${phone_number_id}&no_save=1`;

        const headers = {
            'Content-Type': 'application/json',
            'X-Api-Key': process.env.NWA_ACCESS_KEY!,
        };

        const requestBody = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: phoneNumber,
            type: 'text',
            text: {
                body: body,
            },
        };

        const response = await axios.post(apiUrl, requestBody, { headers });

        return response.data;
    } catch (error) {
        if (error instanceof Error) {
            console.error('Error:', error.message);
            throw error; // Re-throw the error
        } else {
            console.error('Unknown error occurred:', error);
            throw new Error('An unknown error occurred');
        }
    }
}