import pool from '../database';
import { generateRandomCode } from '../utils/codeUtils';

export interface Signer {
    id: number;
    document_id: number;
    phone: string;
    code: string;
    status: 'pending' | 'signed' | 'rejected';
    signed_at: Date | null;
    created_at: Date;
    updated_at: Date;
}

export interface Document {
    id: number;
    reference_id: string | null;
    file_id: string;
    file_name: string;
    is_signed: boolean;
    signed_at: Date | null;
    doc_status: 'approved' | 'rejected';
    rejected_at: Date | null;
    reject_reason: string | null;
    rejected_by: string | null;
    use_stempel: boolean;
    created_at: Date;
    updated_at: Date;
    callback_url: string | null;
    signers: Signer[];
}

export class DocumentRepository {
    private async getSignersForDocument(docId: number): Promise<Signer[]> {
        const query = 'SELECT * FROM signers WHERE document_id = ? ORDER BY id ASC';
        const [rows] = await pool.execute(query, [docId]);
        return rows as Signer[];
    }

    async create(phones: string[], reference_id: string | null, file_id: string, file_name: string, use_stempel: boolean, callback_url: string | null): Promise<void> {
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();

            const docQuery = 'INSERT INTO documents (reference_id, file_id, file_name, is_signed, doc_status, use_stempel, callback_url) VALUES (?, ?, ?, ?, ?, ?, ?)';
            const [result] = await connection.execute(docQuery, [reference_id, file_id, file_name, false, 'approved', use_stempel, callback_url]);
            const docId = (result as any).insertId;

            const signerQuery = 'INSERT INTO signers (document_id, phone, code, status) VALUES (?, ?, ?, ?)';
            for (const phone of phones) {
                const code = generateRandomCode();
                await connection.execute(signerQuery, [docId, phone, code, 'pending']);
            }

            await connection.commit();
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }

    async findSignerByCode(code: string): Promise<Signer | null> {
        const query = 'SELECT * FROM signers WHERE code = ?';
        const [rows] = await pool.execute(query, [code]);
        const signers = rows as Signer[];
        return signers.length > 0 ? signers[0] : null;
    }

    async findById(id: number): Promise<Document | null> {
        const query = 'SELECT * FROM documents WHERE id = ?';
        const [rows] = await pool.execute(query, [id]);
        const documents = rows as Document[];
        if (documents.length === 0) return null;
        const document = documents[0];
        document.signers = await this.getSignersForDocument(document.id);
        return document;
    }

    async findByFileId(fileId: string): Promise<Document | null> {
        const query = 'SELECT * FROM documents WHERE file_id = ?';
        const [rows] = await pool.execute(query, [fileId]);
        const documents = rows as Document[];
        if (documents.length === 0) return null;
        const document = documents[0];
        document.signers = await this.getSignersForDocument(document.id);
        return document;
    }

    async updateSignerSigned(signerId: number): Promise<void> {
        const query = 'UPDATE signers SET status = ?, signed_at = NOW() WHERE id = ?';
        await pool.execute(query, ['signed', signerId]);
    }

    async rejectSigner(signerId: number): Promise<void> {
        const query = 'UPDATE signers SET status = ? WHERE id = ?';
        await pool.execute(query, ['rejected', signerId]);
    }

    async rejectDocument(id: number, reason: string, rejected_by: string): Promise<void> {
        const query = 'UPDATE documents SET doc_status = ?, rejected_at = NOW(), reject_reason = ?, rejected_by = ? WHERE id = ?';
        await pool.execute(query, ['rejected', reason, rejected_by, id]);
    }

    async updateSigned(id: number): Promise<void> {
        const query = 'UPDATE documents SET is_signed = TRUE, signed_at = NOW(), doc_status = ? WHERE id = ?';
        await pool.execute(query, ['approved', id]);
    }
}