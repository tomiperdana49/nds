import dotenv from "dotenv";

dotenv.config();

import express from "express";
import multer from "multer";
import { Readable } from 'stream';
import { google } from "googleapis";
import fetch from "node-fetch";
import { setupDocumentRoutes } from './documentRoutes';

const axios = require('axios');
const PORT = process.env.PORT || 3000;
const FOLDER_ID = process.env.FOLDER_ID!;
const FOLDER_ID_NUSAID = process.env.FOLDER_ID_NUSAID!;
const FOLDER_ID_INTERNAL = process.env.FOLDER_ID_INTERNAL!;
const SERVICE_ACCOUNT_EMAIL = process.env.SERVICE_ACCOUNT_EMAIL!;
const SERVICE_ACCOUNT_KEY = process.env.SERVICE_ACCOUNT_KEY!;

const app = express();
app.use(express.json());

setupDocumentRoutes(app);

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });
const PhoneNumber = require('libphonenumber-js');
const nodemailer = require('nodemailer');

async function sendEmail(
  toEmail: string,
  emailSubject: string,
  emailText: string,
  emailHtml: string
) {
  // Create a transporter object using Gmail's SMTP server
  const HOST_SMTP = process.env.HOST_SMTP!;
  const SMTP_PORT = process.env.SMTP_PORT!;
  const SMTP_USER = process.env.SMTP_USER!;
  const SMTP_PAS = process.env.SMTP_PAS!;
  let transporter = nodemailer.createTransport({
    host: HOST_SMTP,
    port: SMTP_PORT,
    secure: false, // Use TLS
    auth: {
      user: SMTP_USER,
      pass: SMTP_PAS
    }
  });

  // Set up email data
  let mailOptions = {
    from: 'nds@nusa.net.id', // Sender address
    to: toEmail, // Receiver's email address passed as parameter
    subject: emailSubject, // Subject passed as parameter
    text: emailText,
    html: emailHtml
  };

  // Send email
  try {
    let info = await transporter.sendMail(mailOptions);
  } catch (error) {
    console.error('Error sending email:', error);
  }
}

app.get('/download/:fileId', async (req, res) => {
  const { fileId } = req.params;

  if (!fileId) {
    return res.status(400).send({ error: 'File ID is required' });
  }

  try {
    const auth = new google.auth.JWT(
      SERVICE_ACCOUNT_EMAIL,
      undefined,
      SERVICE_ACCOUNT_KEY.replace(/\\n/g, '\n'),
      ['https://www.googleapis.com/auth/drive.readonly']
    );

    await auth.authorize();

    const drive = google.drive({ version: 'v3', auth });

    const metadata = await drive.files.get({
      fileId: fileId,
      fields: 'mimeType,name',
    });

    const mimeType = metadata.data.mimeType;
    const fileName = metadata.data.name;

    if (!mimeType || !fileName) {
      throw new Error('MIME type or filename missing from the file metadata.');
    }

    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);

    const driveResponse = await drive.files.get(
      { fileId: fileId, alt: 'media' },
      { responseType: 'stream' }
    );

    driveResponse.data.on('error', err => {
      console.error('Error streaming the file', err);
      res.status(500).send({ error: 'File streaming failed' });
    }).pipe(res);

  } catch (error) {
    console.error('Error fetching file:', error);
    res.status(500).send({ error: 'File download failed' });
  }
});

app.post("/update", upload.single("file"), async (req, res) => {
  const file = req.file;

  const fileIdToUpdate = req.body.fileId;
  const code = req.body.code;
  const branch = req.body.branch;
  const status = req.body.status ?? "";
  const reason = req.body.reason ?? "";

  if (!file || !code) {
    return res.status(400).send({ error: "No file and code received" });
  }

  const fileStream = file.buffer;

  try {
    const auth = new google.auth.JWT(
      SERVICE_ACCOUNT_EMAIL,
      undefined,
      SERVICE_ACCOUNT_KEY.replace(/\\n/g, "\n"),
      ["https://www.googleapis.com/auth/drive"]
    );

    await auth.authorize();
    const drive = google.drive({ version: "v3", auth });

    const updated = await drive.files.update({
      fileId: fileIdToUpdate,
      requestBody: {
        name: file.originalname, // This updates the name if you want
      },
      media: {
        mimeType: file.mimetype,
        body: Readable.from(fileStream)
      },
    });

    // kalau ada tandatangan selanjutnya kirim wa
    const dataSignatureDetail = await getDataFromIdDocumentSignerTrue(fileIdToUpdate, code, branch);
    const nameFile = file.originalname.replace('.pdf', '');
    const dataSignatureDetailById = await getDataFromIdDocumentSignerTrue(fileIdToUpdate, '', branch);

    if (status == "rejected") {
      const documentSignatureTrue = await getDataFromIdDocumentSignatureTrue(fileIdToUpdate, branch);

      let toEmail = dataSignatureDetailById[0][11];
      let emailSubject = `Rejected document: ${nameFile}`;
      let namaReject = dataSignatureDetail[0][2];
      let emailText = `Dokumen ${nameFile}  yang ditandatangani secara digital ditolak karena ${reason}. Penolakan dilakukan oleh ${namaReject}.`;
      let emailHtml = `Dokumen <strong>${nameFile}</strong> yang ditandatangani secara digital ditolak karena <strong>${reason}</strong>. Penolakan dilakukan oleh <strong>${namaReject}</strong>.`;
      sendEmail(toEmail, emailSubject, emailText, emailHtml);
      function delay(ms: number) {
        return new Promise(resolve => setTimeout(resolve, ms));
      }

      for (const item of documentSignatureTrue) {
        const replayPhone = item?.[3]; // Phone number
        if (replayPhone) {
          try {
            const responseDataReject = await sendHsmMetaRejected(replayPhone, nameFile, reason, namaReject);
            await delay(2000);
          } catch (error) {
            console.error(`Error sending HSM to ${replayPhone}:`, error);
          }
        } else {
          console.error('Missing phone number in documentSignatureTrue:', item);
        }
      }

    }
    const updateDataLogSignature = await updateSignatureForIdDocumentAndCode(fileIdToUpdate, code, 'false', '', branch, status, reason, '');
    const dataNextSignature = await getDataFromIdDocument(fileIdToUpdate, branch);

    if (dataNextSignature.length > 0) {
      let stempelSigner = dataNextSignature[0][8] ? dataNextSignature[0][8].toString().toLowerCase() : false;
      let params = "https://nds.nusa.net.id/?id=" + fileIdToUpdate + "&code=" + dataNextSignature[0][1] + "&stempelSigner=" + stempelSigner + " Docx " + nameFile;
      if (branch) {
        params = "https://nds.nusa.net.id/?id=" + fileIdToUpdate + "&code=" + dataNextSignature[0][1] + "&branch=" + branch + "&stempelSigner=" + stempelSigner + " Docx " + nameFile;
      }

      try {
        if (status != "rejected") {
          const parsedPhoneNumber = PhoneNumber(dataNextSignature[0][3], 'ID');
          const formattedPhoneNumber = parsedPhoneNumber.formatInternational();
          const phoneNumberWithoutSpaces = formattedPhoneNumber.replace(/\s/g, '');
          const namaPic = dataSignatureDetail[0][2];

          // const responseData = await sendHsmMeta(phoneNumberWithoutSpaces, params, namaPic);
          const responseData = await sendHsmMeta(phoneNumberWithoutSpaces, getGreeting(), nameFile, namaPic);

          const responseWa = JSON.stringify(responseData);
          await updateSignatureForIdDocumentAndCode(dataNextSignature[0][0], dataNextSignature[0][1], 'true', responseWa, branch, '', '', namaPic);
        }
        // update ke sheet
      } catch (error) {
        res.status(500).send('Failed to send HSM message.');
      }
      res.send({ updatedFileId: updated.data.id });
    } else {
      const updateDataLogSignature = await updateSignatureForIdDocumentAndCode(fileIdToUpdate, code, 'false', '', branch, status, reason, '');
      // move file
      const moveFile = await moveFileToFolder(fileIdToUpdate, branch);

      // send email to generator when doc is finished signing
      let stempelSignerDoc = dataSignatureDetail[0][9] ? dataSignatureDetail[0][9].toString().toLowerCase() : false;
      let links = "https://nds.nusa.net.id/?id=" + fileIdToUpdate + "&code=" + code + "&stempelSigner=" + stempelSignerDoc;
      if (branch) {
        links = "https://nds.nusa.net.id/?id=" + fileIdToUpdate + "&code=" + code + "&stempelSigner=" + stempelSignerDoc + "&branch=" + branch;
      }
      let toEmail = dataSignatureDetailById[0][11];
      let emailSubject = `Dokumen Telah Ditandatangani: ${nameFile}`;
      let namaSigner = dataSignatureDetail[0][2];
      let emailText = `Dokumen ${nameFile} Telah ditandatangani untuk ambil Dokumen yang telah ditandatangani silahkan click link ini.`;
      let emailHtml = `Dokumen <strong>${nameFile}</strong> Telah ditandatangani untuk ambil Dokumen yang telah ditandatangani silahkan click <a href="${links}" target="_blank">link</a>`;
      sendEmail(toEmail, emailSubject, emailText, emailHtml);

      // send email to Carbon Copy (CC)
      let carbonCopy = dataSignatureDetail[0][15];
      if (carbonCopy) {
        let ccList = carbonCopy.split(',').map(function (email: string): string {
          return email.trim();
        });
        ccList.forEach(function (email: string): void {
          let stempelSignerDoc = dataSignatureDetail[0][9] ? dataSignatureDetail[0][9].toString().toLowerCase() : false;
          let links = "https://nds.nusa.net.id/?id=" + fileIdToUpdate + "&code=" + code + "&stempelSigner=" + stempelSignerDoc;
          if (branch) {
            links = "https://nds.nusa.net.id/?id=" + fileIdToUpdate + "&code=" + code + "&stempelSigner=" + stempelSignerDoc + "&branch=" + branch;
          }
          let toEmail = email;
          let emailSubject = `Dokumen Telah Ditandatangani: ${nameFile}`;
          let namaSigner = dataSignatureDetail[0][2];
          let emailText = `Dokumen ${nameFile} telah ditandatangani oleh ${namaSigner}. Silakan klik tautan berikut untuk mengakses dokumen tersebut: ${links}`;

          let emailHtml = `
    			  Dokumen <strong>${nameFile}</strong> telah ditandatangani oleh <strong>${namaSigner}</strong>.<br><br>
    			  Untuk mengakses dokumen tersebut, silakan klik 
    			  <a href="${links}" target="_blank">tautan ini</a>.<br><br>
    			  <em>Email ini dikirimkan kepada Anda sebagai pihak yang menerima tembusan (CC) dalam proses penandatanganan dokumen.</em>
    			`;
          sendEmail(toEmail, emailSubject, emailText, emailHtml);
        });
      }

      res.send({ success: true, message: moveFile });
    }

  } catch (error) {
    console.log(error);
    res.status(500).send({ error: "File update failed" });
  }
});

function getGreeting() {
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

async function sendHsmMetaMesaageLink(phoneNumber: string, body: any, phone_number_id: any): Promise<any> {
  try {
    // const apiUrl = 'https://nwc.nusa.net.id/api/messages';
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

async function sendHsmMeta(phoneNumber: string, params: any, nameDoc: any, namaPic: any): Promise<any> {
  try {
    const phone_number_id = process.env.NWA_PHONE_NUMBER_ID!;
    // const apiUrl = 'https://nwc.nusa.net.id/api/messages';
    // const apiUrl = 'https://nwc.nusa.net.id/api/messages?phone_number_id=${phone_number_id}&no_save=1';
    const apiUrl = `https://nwc.nusa.net.id/api/messages?phone_number_id=${phone_number_id}&no_save=1`; // ini dikirim dari no xl

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
      throw error; // Re-throw the error
    } else {
      console.error('Unknown error occurred:', error);
      throw new Error('An unknown error occurred');
    }
  }
}

async function sendHsmMetaRejected(phoneNumber: string, nameDocs: any, reason: any, nameRejected: any): Promise<any> {
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
        name: 'notif_penolakan_dokumen',
        language: {
          code: 'id',
        },
        components: [
          {
            type: 'body',
            parameters: [
              {
                type: 'text',
                text: nameDocs,
              },
              {
                type: 'text',
                text: reason,
              },
              {
                type: 'text',
                text: nameRejected
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
      throw error; // Re-throw the error
    } else {
      console.error('Unknown error occurred:', error);
      throw new Error('An unknown error occurred');
    }
  }
}

async function sendHSM(phoneNumber: string, params: any): Promise<any> {
  const ACCESS_KEY = process.env.MB_ACCESS_KEY!;
  const url = "https://conversations.messagebird.com/v1/send";

  const headers = {
    "Authorization": `AccessKey ${ACCESS_KEY}`,
    "Content-Type": "application/json"
  };

  const payload = {
    "type": "hsm",
    "to": phoneNumber,
    "from": "e4887a078a68452da97cd9447292be99",
    "content": {
      "hsm": {
        "namespace": "57596504_c418_4e5f_880d_f84757960843",
        "templateName": "verifikasi_signature_doc_v1",
        "language": {
          "policy": "deterministic",
          "code": "id"
        },
        "params": [params]
      }
    }
  };

  const response = await axios.post(url, payload, { headers });
  return response.data;
}

app.get("/check", async (req, res) => {
  try {
    const { code, docId, branch } = req.query;
    if (!code || !docId) {
      return res.status(400).send({ error: 'Both code and docId parameters are required.' });
    }

    const auth = new google.auth.JWT(
      SERVICE_ACCOUNT_EMAIL,
      undefined,
      SERVICE_ACCOUNT_KEY.replace(/\\n/g, "\n"),
      ["https://www.googleapis.com/auth/drive", "https://www.googleapis.com/auth/spreadsheets.readonly"]
    );

    await auth.authorize();
    const drive = google.drive({ version: "v3", auth });
    const sheets = google.sheets({ version: "v4", auth });
    let nameSheet = 'Docs Generation';

    if (branch == 'nusa.id') {
      nameSheet = 'Docs Generation nusaId';
    } else if (branch == 'nusanet_internal') {
      nameSheet = 'Docs Generation Internal';
    }

    const response = await drive.files.list({
      q: `name='${nameSheet}' and mimeType='application/vnd.google-apps.spreadsheet'`,
    });

    const files = response.data.files;

    if (files?.length === 0) {
      return res.status(404).send("No files found with the name 'Log Signature'.");
    }

    const fileId = files?.[0]?.id;
    const sheetData = await sheets.spreadsheets.values.get({
      spreadsheetId: fileId ? fileId : "default_value",
      range: 'Log Signature!A1:Z100000',
    });

    const sheetDataSigner = await sheets.spreadsheets.values.get({
      spreadsheetId: fileId ? fileId : "default_value",
      range: 'Signer!A1:Z100000',
    });

    const rows = sheetData.data.values;

    const IDDOCUMENT_INDEX = 0;
    const CODE_COLUMN_INDEX = 1;  // Adjust this to the correct column for the code.
    const SIGNATURE_COLUMN_INDEX = 6;  // Adjust this to the correct column for the signature.
    const STATUS_COLUMN_INDEX = 13;
    const REASON_COLUMN_INDEX = 14;
    const PIC_COLUMS_INDEX = 2;
    const NAME_DOC = 10;
    const SENDER = 11;
    const TIME_SIGNED = 7;
    const SENDER_TIME = 12;
    const CARBON_COPY = 15;
    const codes = [];

    // tambahan tomi 2 jan 2025
    interface SignatureData {
      signatures: 'true' | 'false';
      signatureBy: string;
    }

    interface DocumentData {
      [code: string]: SignatureData | string; // This allows both SignatureData and string values
      status: string;
      reason: string;
      pic: string;
    }

    let datas: { [idDocument: string]: DocumentData } = {};
    // end tambahan tomi
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

    if (rows) {
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        const idDocument = row[IDDOCUMENT_INDEX];
        const codeCheck = row[CODE_COLUMN_INDEX];
        const signature = row[SIGNATURE_COLUMN_INDEX];
        const status = row[STATUS_COLUMN_INDEX];
        const reason = row[REASON_COLUMN_INDEX];
        const pic = row[PIC_COLUMS_INDEX];
        const nameFile = row[NAME_DOC];
        let senderDoc = row[SENDER];
        const timeSigned = row[TIME_SIGNED];
        let senderTime = row[SENDER_TIME];
        let carbonCopys = row[CARBON_COPY];
        if (docId === idDocument) {
          codes.push(codeCheck);
        }

        // tambahan tomi 2 jan 2025
        if (idDocument === docId) {
          if (typeof senderTime === 'string') {
            senderTime = senderTime.replace(/ (\d):/, ' 0$1:');
          }
          if (!datas[idDocument]) {
            datas[idDocument] = {
              status: '',
              reason: '',
              pic: '',
            };
          }

          if (!datas[idDocument][codeCheck]) {
            datas[idDocument][codeCheck] = {
              signatures: signature as 'true' | 'false', // Ensure signature is either 'TRUE' or 'FALSE'
              signatureBy: signature === 'TRUE' ? pic as string : "",
            };
          }

          if (status == "rejected") {
            datas[idDocument].status = status;
            datas[idDocument].reason = reason;
            datas[idDocument].pic = pic;
          }

          if (!dataDetails.data) {
            dataDetails.data = {
              idDoc: idDocument,
              nameFile: nameFile,
              sender: senderDoc,
              senderTime: senderTime,
              carbonCopy: '',
              activity: [],
            };
          }
          if (dataDetails.data) {
            if (carbonCopys) {
              dataDetails.data.carbonCopy = carbonCopys;
            }
          }

          let namaPic = pic;
          let senderPhone = '';
          const rowsSignerEmail = sheetDataSigner.data.values;
          if (rowsSignerEmail) {
            const matchingRow = rowsSignerEmail.find(row => row[0] === pic);
            if (matchingRow) {
              const rawPhone = matchingRow[1];
              if (rawPhone) {
                const parsedPhoneNumber = PhoneNumber(rawPhone, 'ID');
                if (parsedPhoneNumber?.isValid()) {
                  const formattedPhoneNumber = parsedPhoneNumber.formatInternational();
                  const parts = formattedPhoneNumber.split(' ');
                  if (parts.length === 4) {
                    parts[2] = '****';
                    senderPhone = ` (WA: ${parts.join(' ')})`;
                  } else if (parts.length === 3) {
                    const masked = '****';
                    const last3 = parts[2].slice(-3);
                    senderPhone = ` (WA: ${parts[0]} ${parts[1]} ${masked} ${last3})`;
                  } else {
                    senderPhone = ` (WA: ${formattedPhoneNumber})`;
                  }
                }
              }
            }
          }
          dataDetails.data.activity.push({
            id: codeCheck,
            signatures: signature === 'TRUE' ? 'TRUE' : 'FALSE',
            sender: senderDoc,
            timeSender: senderTime,
            signatureBy: namaPic + senderPhone,
            timeSigned: signature === 'TRUE' ? timeSigned : '',
          });
        }
        // end tambahan tomi

      }
    }
    // tambahan tomi 2 jan 2025
    // console.log(JSON.stringify(dataDetails, null, 2));
    if (datas[docId as string]) {
      const codeData = datas[docId as string][code as string];
      // const signature = (typeof codeData === 'object' && codeData !== null) ? codeData.signatures.toLowerCase() : undefined;
      const signature = (typeof codeData === 'object' && codeData !== null) ? codeData.signatures.toLowerCase() === 'true' : false;
      const signatureBy = (typeof codeData === 'object' && codeData !== null) ? codeData.signatureBy : "";
      if (datas[docId as string]['status'] == "rejected") {
        return res.send({ success: true, signature: signature, signatureBy: signatureBy, picRejected: datas[docId as string]['pic'], status: datas[docId as string]['status'], reason: datas[docId as string]['reason'], message: 'document has been rejected' });
      } else {
        return res.send({ success: true, signature: signature, signatureBy: signatureBy, picRejected: datas[docId as string]['pic'], status: datas[docId as string]['status'], reason: datas[docId as string]['reason'], dataDetails: dataDetails, message: 'Found the code with the correct signature' });
      }
    } else {
      res.status(404).send({ error: 'the document is no longer active or has been canceled by the operator', codes: codes, code: code });
    }
    // end tambahan tomi

    if (codes.includes(code)) {
      return res.send({ success: true, signature: false, message: 'permitted to sign.', codes: codes, code: code, docId: docId });
    } else {
      res.status(404).send({ error: 'the document is no longer active or has been canceled by the operator', codes: codes, code: code });
      // res.status(404).send({ error: 'Code not found or signature is not true.', codes:codes, code:code });
    }

  } catch (error) {
    if (error instanceof Error) {
      console.error("Error fetching data:", error);
      res.status(500).send({ error: `Failed to fetch data from Google Sheet. Reason: ${error.message}` });
    } else {
      console.error("Unknown error:", error);
      res.status(500).send({ error: "Failed to fetch data from Google Sheet." });
    }
  }


});

app.get("/test", async (req, res) => {
  const parsedPhoneNumber = PhoneNumber('+62 813-7706-1570', 'ID');
  const formattedPhoneNumber = parsedPhoneNumber.formatInternational();
  const phoneNumberWithoutSpaces = formattedPhoneNumber.replace(/\s/g, '');
  return res.send({ success: true, phoneNumberWithoutSpaces });
  // const responseData = await sendHsmMeta("+6281377061570", "TEST TOMI");
  // return res.send({ success: true, responseData});
  // const responseData = await sendHSM("+6281377061570", { "default": 'TEST' });
  // return res.send({ success: true, responseData});

  // const resultArray = await getDataFromIdDocument("1U2U2cN9pKl44dnkg1sCsPBwzOFSVbLVP");
  // return res.send({ success: true, data: resultArray });

  // const resultArray = await updateSignatureForIdDocumentAndCode("1DTVwYqowETyPV_RW34W3yMtMYr73cphp","LSD36OMOTNZVA9VD1M9J",'true');
  // return res.send({ success: true, data: resultArray });

  // const result = await moveFileToFolder("1E7y5Fdl65PmwCiV7TXnWcZqy3QEeJJjt");
  // res.send({ success: true, message: result });

});

async function moveFileToFolder(fileId: string, branch: string): Promise<string> {
  try {
    const auth = new google.auth.JWT(
      SERVICE_ACCOUNT_EMAIL,
      undefined,
      SERVICE_ACCOUNT_KEY.replace(/\\n/g, "\n"),
      ["https://www.googleapis.com/auth/drive"]
    );

    await auth.authorize();
    const drive = google.drive({ version: "v3", auth });

    // Get the file's current parents
    const fileMetadata = await drive.files.get({
      fileId: fileId,
      fields: "parents",
    });

    // Define the new parents by adding the target folder and removing the current parents
    const newParents = [];
    if (fileMetadata.data.parents && fileMetadata.data.parents.length > 0) {
      newParents.push(...fileMetadata.data.parents);
    }

    if (branch == 'nusa.id') {
      await drive.files.update({
        fileId: fileId,
        addParents: FOLDER_ID_NUSAID,
        removeParents: newParents.join(","),
        fields: 'id, parents',
      });
    } else if (branch == 'nusanet_internal') {
      await drive.files.update({
        fileId: fileId,
        addParents: FOLDER_ID_INTERNAL,
        removeParents: newParents.join(","),
        fields: 'id, parents',
      });

    } else {
      await drive.files.update({
        fileId: fileId,
        addParents: FOLDER_ID,
        removeParents: newParents.join(","),
        fields: 'id, parents',
      });
    }

    console.log("File moved to folder successfully.");
    return "File moved to folder successfully.";
  } catch (error) {
    console.error("Error moving file to folder:", (error as Error).message);
    throw new Error("Error moving file to folders: " + (error as Error).message);
  }
}

app.post("/get-send-link", async (req, res) => {
  try {
    let { phone, phone_number_id } = req.body;

    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    const expectedToken = process.env.GET_LINK_TOKEN;
    if (!token || token !== expectedToken) {
      return res.status(403).json({ error: 'Forbidden. Invalid or missing token.' });
    }

    phone = `+${phone}`;
    if (!phone || !phone_number_id) {
      return res.status(400).send({ error: "Phone parameter is required." });
    }

    const auth = new google.auth.JWT(
      SERVICE_ACCOUNT_EMAIL,
      undefined,
      SERVICE_ACCOUNT_KEY.replace(/\\n/g, "\n"),
      [
        "https://www.googleapis.com/auth/drive",
        "https://www.googleapis.com/auth/spreadsheets.readonly",
      ]
    );

    await auth.authorize();
    const drive = google.drive({ version: "v3", auth });
    const sheets = google.sheets({ version: "v4", auth });

    // Array of sheet names to search for
    const nameSheets = ['Docs Generation Internal', 'Docs Generation', 'Docs Generation nusaId'];

    // Final result array to store URLs for each sheet
    const resultUrls = [];

    // Kirim response 200 terlebih dahulu
    res.setHeader('Content-Type', 'application/json');
    res.status(200).json({ message: "Proses sedang berjalan di latar belakang" });

    // Mulai proses di latar belakang
    (async () => {
      for (const nameSheet of nameSheets) {
        const response = await drive.files.list({
          q: `name='${nameSheet}' and mimeType='application/vnd.google-apps.spreadsheet'`,
        });

        const files = response.data.files;
        if (files?.length === 0) {
          continue;
        }

        const fileId = files?.[0]?.id;
        const sheetData = await sheets.spreadsheets.values.get({
          spreadsheetId: fileId ? fileId : "default_value",
          range: "Log Signature!A1:Z100000",
        });
        const rows = sheetData.data.values;

        if (!rows || rows.length === 0) {
          continue;
        }

        // Filter the rows where the conditions are met
        const filteredRows = rows.slice(1).filter((row) => {
          const telephone = row[3];
          const signer = row[6];
          const isTrue = row[4] === "TRUE"; // kolom sendWhatsapp
          return telephone === phone && signer.toUpperCase() === "FALSE" && isTrue;
        });
        console.log(nameSheet);
        console.log(filteredRows.length);

        if (filteredRows.length === 0) {
          continue;
        }

        function delay(ms: number) {
          return new Promise(resolve => setTimeout(resolve, ms));
        }

        for (const [index, row] of filteredRows.entries()) {
          const id = row[0];
          const code = row[1];
          const stempelSigner = row[9];
          let params;

          let nameDoc;
          try {
            const fileMetadata = await drive.files.get({
              fileId: id,
              fields: 'name',
            });
            nameDoc = fileMetadata.data.name;
          } catch (error) {
            console.error(`Error fetching file metadata for file ID ${id}:`, error);
            continue;
          }

          if (nameSheet == "Docs Generation Internal") {
            params = `https://nds.nusa.net.id/?id=${id}&code=${code}&stempelSigner=${stempelSigner}&branch=nusanet_internal`;
          } else if (nameSheet == "Docs Generation nusaId") {
            params = `https://nds.nusa.net.id/?id=${id}&code=${code}&stempelSigner=${stempelSigner}&branch=nusa.id`;
          } else {
            params = `https://nds.nusa.net.id/?id=${id}&code=${code}&stempelSigner=${stempelSigner}`;
          }

          try {
            let body = `Documen *${nameDoc}* silahkan click link untuk menandatangani: ${params}`;
            await sendHsmMetaMesaageLink(phone, body, phone_number_id);

            // Delay of 2 seconds
            await delay(2000);
          } catch (error) {
            console.error(`Error sending WhatsApp message for row ${index + 1} in sheet ${nameSheet}:`, error);
          }

          resultUrls.push({
            filename: nameDoc,
            link: params
          });
        }
      }

      if (resultUrls.length === 0) {
        let body = `Tidak ada dokumen yang perlu ditandatangani.`;
        await sendHsmMetaMesaageLink(phone, body, phone_number_id);
      }
    })();
  } catch (error) {
    console.error(error);
    return res.status(500).send("Internal server error.");
  }
});

async function updateSignatureForIdDocumentAndCode(docId: string, code: string, send: string, responseWa: string, branch: string, status: string, reason: string, namePic: string): Promise<string> {
  try {
    if (!docId) {
      throw new Error('docId parameter is required.');
    }

    const auth = new google.auth.JWT(
      SERVICE_ACCOUNT_EMAIL,
      undefined,
      SERVICE_ACCOUNT_KEY.replace(/\\n/g, "\n"),
      ["https://www.googleapis.com/auth/drive", "https://www.googleapis.com/auth/spreadsheets.readonly"]
    );

    await auth.authorize();
    const drive = google.drive({ version: "v3", auth });
    const sheets = google.sheets({ version: "v4", auth });
    let nameSheet = 'Docs Generation';

    if (branch == 'nusa.id') {
      nameSheet = 'Docs Generation nusaId';
    } else if (branch == 'nusanet_internal') {
      nameSheet = 'Docs Generation Internal';
    }

    const response = await drive.files.list({
      q: `name='${nameSheet}' and mimeType='application/vnd.google-apps.spreadsheet'`,
    });

    const files = response.data.files;

    if (files?.length === 0) {
      throw new Error("No files found with the name 'Log Signature'.");
    }

    const fileId = files?.[0]?.id;
    const sheetData = await sheets.spreadsheets.values.get({
      spreadsheetId: fileId ? fileId : "default_value",
      range: 'Log Signature!A1:Z100000',
    });

    const rows = sheetData.data.values;

    const sheetDataSigner = await sheets.spreadsheets.values.get({
      spreadsheetId: fileId ? fileId : "default_value",
      range: 'Signer!A1:Z100000',
    });

    const IDDOCUMENT_INDEX = 0;
    const CODE_COLUMN_INDEX = 1;
    let rowToUpdate = null;

    if (rows) {
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const currentIdDocument = row[IDDOCUMENT_INDEX];
        const currentCode = row[CODE_COLUMN_INDEX];
        if (currentIdDocument === docId && currentCode === code) {
          rowToUpdate = i + 1;  // +1 to adjust for 0-based index
          break;
        }
      }
    }
    const currentDate = new Date();
    const formattedDate = `${currentDate.getFullYear()}-${String(currentDate.getMonth() + 1).padStart(2, '0')}-${String(currentDate.getDate()).padStart(2, '0')} ${String(currentDate.getHours()).padStart(2, '0')}:${String(currentDate.getMinutes()).padStart(2, '0')}:${String(currentDate.getSeconds()).padStart(2, '0')}`;

    if (status) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: fileId ? fileId : "default_value",
        range: `Log Signature!N${rowToUpdate}`,
        valueInputOption: 'RAW',
        resource: {
          values: [[status]]
        }
      } as any);

      await sheets.spreadsheets.values.update({
        spreadsheetId: fileId ? fileId : "default_value",
        range: `Log Signature!O${rowToUpdate}`,
        valueInputOption: 'RAW',
        resource: {
          values: [[reason]]
        }
      } as any);

    }
    if (rowToUpdate !== null && send == 'false') {
      await sheets.spreadsheets.values.update({
        spreadsheetId: fileId ? fileId : "default_value",
        range: `Log Signature!G${rowToUpdate}`,
        valueInputOption: 'RAW',
        resource: {
          values: [[true]]
        }
      } as any);

      await sheets.spreadsheets.values.update({
        spreadsheetId: fileId ? fileId : "default_value",
        range: `Log Signature!H${rowToUpdate}`,
        valueInputOption: 'RAW',
        resource: {
          values: [[formattedDate]]
        }
      } as any);

      await sheets.spreadsheets.values.update({
        spreadsheetId: fileId ? fileId : "default_value",
        range: `Log Signature!I${rowToUpdate}`, // Change 'F' to 'I' for Column I
        valueInputOption: 'RAW',
        resource: {
          values: [[false]] // Set the value to an empty string to remove the checkbox
        }
      } as any);
      return 'Signature updated successfully.';
    } else if (rowToUpdate !== null && send == 'true') {
      await sheets.spreadsheets.values.update({
        spreadsheetId: fileId ? fileId : "default_value",
        range: `Log Signature!E${rowToUpdate}`,
        valueInputOption: 'RAW',
        resource: {
          values: [[true]]
        }
      } as any);
      await sheets.spreadsheets.values.update({
        spreadsheetId: fileId ? fileId : "default_value",
        range: `Log Signature!F${rowToUpdate}`,
        valueInputOption: 'RAW',
        resource: {
          values: [[responseWa]]
        }
      } as any);
      await sheets.spreadsheets.values.update({
        spreadsheetId: fileId ? fileId : "default_value",
        range: `Log Signature!L${rowToUpdate}`,
        valueInputOption: 'RAW',
        resource: {
          values: [[namePic]]
        }
      } as any);
      await sheets.spreadsheets.values.update({
        spreadsheetId: fileId ? fileId : "default_value",
        range: `Log Signature!M${rowToUpdate}`,
        valueInputOption: 'RAW',
        resource: {
          values: [[formattedDate]]
        }
      } as any);
      return 'Signature updated successfully.';
    } else {
      throw new Error('IdDocument or code not found.');
    }

  } catch (error) {
    console.error("Error fetching data:", error);
    throw error;
  }
}

async function getDataFromIdDocumentSignerTrue(docId: string, code: string, branch: string): Promise<any[]> {
  try {
    if (!docId) {
      throw new Error('docId parameter is required.');
    }

    const auth = new google.auth.JWT(
      SERVICE_ACCOUNT_EMAIL,
      undefined,
      SERVICE_ACCOUNT_KEY.replace(/\\n/g, "\n"),
      ["https://www.googleapis.com/auth/drive", "https://www.googleapis.com/auth/spreadsheets.readonly"]
    );

    await auth.authorize();
    const drive = google.drive({ version: "v3", auth });
    const sheets = google.sheets({ version: "v4", auth });
    let nameSheet = 'Docs Generation';

    if (branch == 'nusa.id') {
      nameSheet = 'Docs Generation nusaId';
    } else if (branch == 'nusanet_internal') {
      nameSheet = 'Docs Generation Internal';
    }

    const response = await drive.files.list({
      q: `name='${nameSheet}' and mimeType='application/vnd.google-apps.spreadsheet'`,
    });

    const files = response.data.files;

    if (files?.length === 0) {
      throw new Error("No files found with the name 'Log Signature'.");
    }

    const fileId = files?.[0]?.id;
    const sheetData = await sheets.spreadsheets.values.get({
      spreadsheetId: fileId ? fileId : "default_value",
      range: 'Log Signature!A1:Z100000',
    });

    const rows = sheetData.data.values;

    const IDDOCUMENT_INDEX = 0;
    const CODE_COLUMN_INDEX = 1;
    const dataDocumentId = [];

    if (rows) {
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        const idDocument = row[IDDOCUMENT_INDEX];
        const codeR = row[CODE_COLUMN_INDEX];

        if (idDocument === docId && code === codeR) {
          dataDocumentId.push(row);
          break;
        }
        if (!code && idDocument === docId) {
          dataDocumentId.push(row);
        }
      }
    }

    return dataDocumentId;

  } catch (error) {
    console.error("Error fetching data:", error);
    throw error;
  }
}



// ambil data selanjutnya berdasarkan id document
async function getDataFromIdDocument(docId: string, branch: string): Promise<any[]> {
  try {
    if (!docId) {
      throw new Error('docId parameter is required.');
    }

    const auth = new google.auth.JWT(
      SERVICE_ACCOUNT_EMAIL,
      undefined,
      SERVICE_ACCOUNT_KEY.replace(/\\n/g, "\n"),
      ["https://www.googleapis.com/auth/drive", "https://www.googleapis.com/auth/spreadsheets.readonly"]
    );

    await auth.authorize();
    const drive = google.drive({ version: "v3", auth });
    const sheets = google.sheets({ version: "v4", auth });
    let nameSheet = 'Docs Generation';

    if (branch == 'nusa.id') {
      nameSheet = 'Docs Generation nusaId';
    } else if (branch == 'nusanet_internal') {
      nameSheet = 'Docs Generation Internal';
    }

    const response = await drive.files.list({
      q: `name='${nameSheet}' and mimeType='application/vnd.google-apps.spreadsheet'`,
    });

    const files = response.data.files;

    if (files?.length === 0) {
      throw new Error("No files found with the name 'Log Signature'.");
    }

    const fileId = files?.[0]?.id;
    const sheetData = await sheets.spreadsheets.values.get({
      spreadsheetId: fileId ? fileId : "default_value",
      range: 'Log Signature!A1:Z100000',
    });

    const rows = sheetData.data.values;

    const IDDOCUMENT_INDEX = 0;
    const SIGNATURE_COLUMN_INDEX = 6;
    const dataDocumentId = [];

    if (rows) {
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        const idDocument = row[IDDOCUMENT_INDEX];
        const signature = row[SIGNATURE_COLUMN_INDEX];

        if (idDocument === docId && signature === 'FALSE') {
          dataDocumentId.push(row);
          break;
        }
      }
    }

    return dataDocumentId;

  } catch (error) {
    console.error("Error fetching data:", error);
    throw error;
  }
}

async function getDataFromIdDocumentSignatureTrue(docId: string, branch: string): Promise<any[]> {
  try {
    if (!docId) {
      throw new Error('docId parameter is required.');
    }

    const auth = new google.auth.JWT(
      SERVICE_ACCOUNT_EMAIL,
      undefined,
      SERVICE_ACCOUNT_KEY.replace(/\\n/g, "\n"),
      ["https://www.googleapis.com/auth/drive", "https://www.googleapis.com/auth/spreadsheets.readonly"]
    );

    await auth.authorize();
    const drive = google.drive({ version: "v3", auth });
    const sheets = google.sheets({ version: "v4", auth });
    let nameSheet = 'Docs Generation';

    if (branch == 'nusa.id') {
      nameSheet = 'Docs Generation nusaId';
    } else if (branch == 'nusanet_internal') {
      nameSheet = 'Docs Generation Internal';
    }

    const response = await drive.files.list({
      q: `name='${nameSheet}' and mimeType='application/vnd.google-apps.spreadsheet'`,
    });

    const files = response.data.files;

    if (files?.length === 0) {
      throw new Error("No files found with the name 'Log Signature'.");
    }

    const fileId = files?.[0]?.id;
    const sheetData = await sheets.spreadsheets.values.get({
      spreadsheetId: fileId ? fileId : "default_value",
      range: 'Log Signature!A1:Z100000',
    });

    const rows = sheetData.data.values;

    const IDDOCUMENT_INDEX = 0;
    const SIGNATURE_COLUMN_INDEX = 6;
    const dataDocumentId = [];

    if (rows) {
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        const idDocument = row[IDDOCUMENT_INDEX];
        const signature = row[SIGNATURE_COLUMN_INDEX];

        if (idDocument === docId && signature === 'TRUE') {
          dataDocumentId.push(row);
        }
      }
    }

    return dataDocumentId;

  } catch (error) {
    console.error("Error fetching data:", error);
    throw error;
  }
}


app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

