import { Express } from "express";
import multer from "multer";
import { Readable } from 'stream';
import { google } from "googleapis";
import { sendHsmMeta, sendToWhatsappInternal, sendHsmMetaMesaageLink } from './services/whatsappService';
import { generateRandomCode, buildPoUrl } from './utils/codeUtils';
import { PoDocumentRepository } from './repositories/poDocumentRepository';

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });
const uploadNone = multer().none();
const PhoneNumber = require('libphonenumber-js');

export function setupPoRoutes(app: Express) {
    const SERVICE_ACCOUNT_EMAIL = process.env.SERVICE_ACCOUNT_EMAIL!;
    const SERVICE_ACCOUNT_KEY = process.env.SERVICE_ACCOUNT_KEY!;
    const FOLDER_ID = process.env.FOLDER_ID_PO!;
    const repository = new PoDocumentRepository();

    app.post("/doc/create", upload.single("file"), async (req, res) => {
        const file = req.file;
        let { phone, reference_id } = req.body;

        if (!file || !phone) {
            return res.status(400).send({ error: "File and phone are required" });
        }

        // Format phone number
        const parsedPhoneNumber = PhoneNumber(phone, 'ID');
        if (!parsedPhoneNumber.isValid()) {
            return res.status(400).send({ error: "Invalid phone number" });
        }
        phone = parsedPhoneNumber.formatInternational();

        try {
            const auth = new google.auth.JWT(
                SERVICE_ACCOUNT_EMAIL,
                undefined,
                SERVICE_ACCOUNT_KEY.replace(/\\n/g, "\n"),
                ["https://www.googleapis.com/auth/drive"]
            );

            await auth.authorize();
            const drive = google.drive({ version: "v3", auth });

            const created = await drive.files.create({
                requestBody: {
                    name: file.originalname,
                    parents: [FOLDER_ID],
                },
                media: {
                    mimeType: file.mimetype,
                    body: Readable.from(file.buffer)
                },
            });

            const fileId = created.data.id!;

            const code = generateRandomCode();

            // reference_id is optional now; store empty string if missing
            await repository.create(phone, reference_id, code, fileId, file.originalname);

            const url = buildPoUrl(fileId, code);

            // const body = `Silahkan tanda tangani dokumen berikut ${url}`;
            // await sendHsmMeta(phone, body, file.originalname, 'PT Media Antar Nusa');
            const body = `Silahkan tanda tangani dokumen *${file.originalname}* dari PT Media Antar Nusa: ${url}`;
            await sendHsmMetaMesaageLink(phone, body);

            res.send({ success: true, fileId: fileId, message: "Document created successfully" });
        } catch (error) {
            console.error(error);
            res.status(500).send({ error: "Failed to create document" });
        }
    });

    app.post("/doc/sign", upload.single("file"), async (req, res) => {
        const file = req.file;
        const { code, file_id } = req.body;

        if (!file || !code || !file_id) {
            return res.status(400).send({ error: "File, code, and file_id are required" });
        }

        try {
            const document = await repository.findUnsignedByCodeAndFileId(code, file_id);

            if (!document) {
                return res.status(404).send({ error: "Document not found or already signed/rejected" });
            }

            const auth = new google.auth.JWT(
                SERVICE_ACCOUNT_EMAIL,
                undefined,
                SERVICE_ACCOUNT_KEY.replace(/\\n/g, "\n"),
                ["https://www.googleapis.com/auth/drive"]
            );

            await auth.authorize();
            const drive = google.drive({ version: "v3", auth });

            const updated = await drive.files.update({
                fileId: file_id,
                requestBody: {
                    name: document.file_name,
                },
                media: {
                    mimeType: file.mimetype,
                    body: Readable.from(file.buffer)
                },
            });

            await repository.updateSigned(document.id);

            res.send({ success: true, fileId: file_id, message: "Document signed successfully" });
        } catch (error) {
            console.error(error);
            res.status(500).send({ error: "Failed to sign document" });
        }
    });

    app.post("/doc/reject", uploadNone, async (req, res) => {
        const { code, file_id, reason } = req.body;

        if (!code || !file_id || !reason) {
            return res.status(400).send({ error: "Code, file_id, and reason are required" });
        }

        try {
            const document = await repository.findByCodeAndFileId(code, file_id);

            if (!document) {
                return res.status(404).send({ error: "Document not found" });
            }

            if (document.doc_status === 'rejected') {
                return res.status(400).send({ error: "Document has already been rejected" });
            }

            if (document.is_signed) {
                return res.status(400).send({ error: "Document already signed" });
            }

            const rejected_by = document.phone || '';

            await repository.rejectDocument(document.id, reason, rejected_by);

            res.send({ success: true, message: "Document rejected successfully" });
        } catch (error) {
            console.error(error);
            res.status(500).send({ error: "Failed to reject document" });
        }
    });

    app.get("/doc/check", async (req, res) => {
        const { code, file_id } = req.query;

        if (!code || !file_id) {
            return res.status(400).send({ error: "Both code and file_id parameters are required." });
        }

        try {
            const document = await repository.findByCodeAndFileId(code as string, file_id as string);

            if (!document) {
                return res.status(404).send({ error: "Document not found." });
            }

            const isSigned = document.is_signed;
            const signedAt = document.signed_at;
            const status = document.doc_status;
            const reason = document.reject_reason;
            const picRejected = document.rejected_by;

            // Build datas structure
            let datas: { [idDocument: string]: any } = {};
            datas[file_id as string] = {
                is_signed: isSigned,
                signed_at: signedAt,
                reference_id: document.reference_id,
                phone: document.phone,
            };

            // Build dataDetails structure
            let dataDetails: {
                data?: {
                    idDoc: string;
                    nameFile: string;
                    sender: string;
                    senderTime: string;
                    carbonCopy: string;
                    activity: {
                        id: string;
                        signatures: 'TRUE' | 'FALSE';
                        sender: string;
                        timeSender: string;
                        signatureBy: string;
                        timeSigned: string;
                    }[];
                };
            } = {};

            dataDetails.data = {
                idDoc: file_id as string,
                nameFile: document.file_name,
                sender: 'PT Media Antar Nusa',
                senderTime: document.created_at.toISOString(),
                carbonCopy: '',
                activity: [{
                    id: document.code,
                    signatures: isSigned ? 'TRUE' : 'FALSE',
                    sender: 'PT Media Antar Nusa',
                    timeSender: document.created_at.toISOString(),
                    signatureBy: document.phone,
                    timeSigned: signedAt ? signedAt.toISOString() : '',
                }],
            };

            let message: string;
            if (status === 'rejected') {
                message = 'document has been rejected';
            } else {
                message = isSigned ? "Document has been signed." : "Document is not yet signed.";
            }


            return res.send({
                success: true,
                signature: isSigned,
                signed_at: signedAt,
                status: status,
                reason: reason,
                picRejected: picRejected,
                message: message,
                datas: datas,
                dataDetails: dataDetails,
            });
        } catch (error) {
            console.error(error);
            res.status(500).send({ error: "Failed to check document status." });
        }
    });
}
