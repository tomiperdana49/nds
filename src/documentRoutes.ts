import { Express } from "express";
import multer from "multer";
import { Readable } from 'stream';
import { google } from "googleapis";
import { sendHsmMeta, sendToWhatsappInternal, sendHsmMetaMessageLink } from './services/whatsappService';
import { generateRandomCode, buildPoUrl } from './utils/codeUtils';
import { DocumentRepository } from './repositories/documentRepository';

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });
const uploadNone = multer().none();
const PhoneNumber = require('libphonenumber-js');

export function setupDocumentRoutes(app: Express) {
    const SERVICE_ACCOUNT_EMAIL = process.env.SERVICE_ACCOUNT_EMAIL!;
    const SERVICE_ACCOUNT_KEY = process.env.SERVICE_ACCOUNT_KEY!;
    const FOLDER_ID = process.env.FOLDER_ID_DOC!;
    const repository = new DocumentRepository();

    app.post("/doc/create", upload.single("file"), async (req, res) => {
        const file = req.file;
        let { phones, reference_id, use_stempel } = req.body;

        let useStempel = false;
        if (typeof use_stempel === 'boolean') {
            useStempel = use_stempel;
        } else if (typeof use_stempel === 'string') {
            const v = use_stempel.trim().toLowerCase();
            useStempel = (v === 'true' || v === '1');
        } else if (typeof use_stempel === 'number') {
            useStempel = use_stempel === 1;
        }

        if (!file) {
            return res.status(400).send({ error: "File is required" });
        }

        if (!phones) {
            return res.status(400).send({ error: "Phones are required and must be an array of strings" });
        }

        if (!Array.isArray(phones) || phones.length === 0) {
            return res.status(400).send({ error: "Phones must be a non-empty array of strings" });
        }

        const formattedPhones: string[] = [];
        for (const phone of phones) {
            const parsedPhoneNumber = PhoneNumber(phone, 'ID');
            if (!parsedPhoneNumber.isValid()) {
                return res.status(400).send({ error: `Invalid phone number: ${phone}` });
            }
            formattedPhones.push(parsedPhoneNumber.formatInternational());
        }

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

            await repository.create(formattedPhones, reference_id ?? '', fileId, file.originalname, useStempel);

            const createdDocument = await repository.findByFileId(fileId);
            if (!createdDocument) {
                throw new Error('Failed to retrieve created document');
            }

            if (createdDocument.signers.length > 0) {
                const firstSigner = createdDocument.signers[0];
                const url = buildPoUrl(fileId, firstSigner.code, createdDocument.use_stempel);
                await sendHsmMetaMessageLink(firstSigner.phone, file.originalname, 'PT Media Antar Nusa', url);
            }

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
            const signer = await repository.findSignerByCode(code);

            if (!signer) {
                return res.status(404).send({ error: "Signer not found" });
            }

            const document = await repository.findById(signer.document_id);

            if (!document || document.file_id !== file_id) {
                return res.status(404).send({ error: "Document not found or file_id mismatch" });
            }

            if (signer.status === 'signed') {
                return res.status(400).send({ error: "Signer has already signed" });
            }

            if (signer.status === 'rejected') {
                return res.status(400).send({ error: "Cannot sign a rejected document" });
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

            await repository.updateSignerSigned(signer.id);

            // Check if all signers have signed
            const updatedDocument = await repository.findById(signer.document_id);
            const allSigned = updatedDocument!.signers.every(s => s.status === 'signed');
            if (allSigned) {
                await repository.updateSigned(document.id);
            } else {
                const currentIndex = updatedDocument!.signers.findIndex(s => s.id === signer.id);
                let nextSigner = null;
                for (let i = currentIndex + 1; i < updatedDocument!.signers.length; i++) {
                    if (updatedDocument!.signers[i].status === 'pending') {
                        nextSigner = updatedDocument!.signers[i];
                        break;
                    }
                }
                if (nextSigner) {
                    const url = buildPoUrl(file_id, nextSigner.code, document.use_stempel);
                    await sendHsmMetaMessageLink(nextSigner.phone, document.file_name, 'PT Media Antar Nusa', url);
                }
            }

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
            const signer = await repository.findSignerByCode(code);

            if (!signer) {
                return res.status(404).send({ error: "Signer not found" });
            }

            const document = await repository.findById(signer.document_id);

            if (!document || document.file_id !== file_id) {
                return res.status(404).send({ error: "Document not found or file_id mismatch" });
            }

            if (signer.status === 'rejected') {
                return res.status(400).send({ error: "Signer has already been rejected" });
            }

            if (signer.status === 'signed') {
                return res.status(400).send({ error: "Cannot reject a signed signer" });
            }

            await repository.rejectSigner(signer.id);
            await repository.rejectDocument(document.id, reason, signer.phone);

            res.send({ success: true, message: "Signer rejected successfully" });
        } catch (error) {
            console.error(error);
            res.status(500).send({ error: "Failed to reject signer" });
        }
    });

    app.get("/doc/check", async (req, res) => {
        const { code, file_id } = req.query;

        if (!code || !file_id) {
            return res.status(400).send({ error: "Both code and file_id parameters are required." });
        }

        try {
            const signer = await repository.findSignerByCode(code as string);

            if (!signer) {
                return res.status(404).send({ error: "Signer not found." });
            }

            const document = await repository.findById(signer.document_id);

            if (!document || document.file_id !== file_id) {
                return res.status(404).send({ error: "Document not found or file_id mismatch." });
            }

            const isSigned = signer.status === 'signed';
            const signedAt = signer.status === 'signed' ? signer.signed_at : null;
            const status = document.doc_status;
            const reason = document.reject_reason;
            const picRejected = document.rejected_by;

            // Build datas structure
            let datas: { [idDocument: string]: any } = {};
            datas[file_id as string] = {
                is_signed: isSigned,
                signed_at: signedAt,
                reference_id: document.reference_id,
                phones: document.signers.map(s => s.phone),
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
                activity: [],
            };

            // Build activity timeline
            let previousTime = document.created_at;
            for (const signer of document.signers) {
                const receivedTime = previousTime.toISOString();
                const actionTime = signer.status === 'signed' ? (signer.signed_at ? signer.signed_at.toISOString() : '') : (signer.status === 'rejected' ? (document.rejected_at ? document.rejected_at.toISOString() : '') : '');
                const isSigned = signer.status === 'signed' ? 'TRUE' : 'FALSE';

                dataDetails.data.activity.push({
                    id: signer.code,
                    signatures: isSigned,
                    sender: 'PT Media Antar Nusa',
                    timeSender: receivedTime,
                    signatureBy: signer.phone,
                    timeSigned: actionTime,
                });

                // Update previousTime for next signer
                if (signer.status === 'signed' && signer.signed_at) {
                    previousTime = signer.signed_at;
                } else if (signer.status === 'rejected' && document.rejected_at) {
                    previousTime = document.rejected_at;
                }
            }

            let message: string;
            if (status === 'rejected' || document.signers.some(s => s.status === 'rejected')) {
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
