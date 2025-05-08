import * as fs from 'fs'
import * as path from 'path'
import Database = require('better-sqlite3')
import * as Loki from 'lokijs'
import { performance } from 'perf_hooks'
import { getUserHomeDir } from '@aws/lsp-core/out/util/path'
import { FileSystemAdapter } from './util'
import { Features } from '@aws/language-server-runtimes/server-interface/server'
import * as crypto from 'crypto'

export class StorageBenchmark {
    #lokiDb: Loki
    #sqliteDb: Database.Database
    #dbDirectory: string
    sqlitePath = 'sqlite-chat-history.db'
    lokijsPath = 'loki-chat-history.json'
    lokijsDbName = 'loki-chat-history.json'

    constructor(features: Features) {
        this.#dbDirectory = path.join(getUserHomeDir(), '.aws/amazonq/history')
        // Ensure the directory exists
        if (!fs.existsSync(this.#dbDirectory)) {
            fs.mkdirSync(this.#dbDirectory, { recursive: true })
            console.log(`Created directory: ${this.#dbDirectory}`)
        }
        this.lokijsPath = path.join(this.#dbDirectory, 'loki-chat-history.json')
        this.#lokiDb = this.initializeLokiDb(features)

        this.sqlitePath = path.join(this.#dbDirectory, 'sqlite-chat-history.db')
        this.#sqliteDb = this.initializeSqliteDb()
        console.log('====== Started benchmark ======')
    }

    close() {
        this.#lokiDb.close()
        this.#sqliteDb.close()
    }

    // Initialize LokiDB
    initializeLokiDb(features: Features): Loki {
        console.log(`initializing db at location ${this.lokijsPath}`)
        const lokiDb = new Loki(this.lokijsDbName, {
            adapter: new FileSystemAdapter(features.workspace, this.#dbDirectory),
            // autoload: true,
            // autoloadCallback: () => this.getOrInitialize(),
            // autosave: true,
            // autosaveInterval: 1000,
            persistenceMethod: 'fs',
        })
        return lokiDb
    }

    // Initialize SQLite DB
    initializeSqliteDb(): Database.Database {
        // Create and configure the database
        const sqliteDb = new Database(this.sqlitePath)
        sqliteDb.pragma('journal_mode = WAL')

        return sqliteDb
    }

    getOrInitialize() {
        let entries = this.#lokiDb.getCollection('history')
        if (entries === null) {
            console.log(`Creating new collection`)
            entries = this.#lokiDb.addCollection('history', {
                unique: ['historyId'],
                indices: ['updatedAt', 'isOpen'],
            })
        }
        return entries
    }

    /**
     * Generates a UUID v4 string using Node.js crypto module
     * @returns A UUID v4 string
     */
    generateUUID(): string {
        return crypto.randomUUID()
    }

    /**
     * Generates a UUID v4 string with a prefix
     * @param prefix The prefix to add to the UUID
     * @returns A prefixed UUID string
     */
    generatePrefixedId(prefix: string): string {
        return `${prefix}-${this.generateUUID()}`
    }

    // Test data generation
    generateTestData(messageCount: number, avgCharPerMessage: number): any[] {
        const messages = []
        for (let i = 0; i < messageCount; i++) {
            messages.push({
                type: i % 2 === 0 ? 'prompt' : 'answer',
                body: i % 200 === 0 ? 'targetString' + 'A'.repeat(avgCharPerMessage) : 'B'.repeat(avgCharPerMessage),
                messageId: i == messageCount / 2 ? 'msg-to-delete' : this.generatePrefixedId(`msg-${i}`),
                timestamp: new Date().toISOString(),
                userInputMessageContext: {
                    editorState: { cursor: 0, selection: [0, 0] },
                    additionalContext: [],
                    toolResults: [],
                },
            })
        }
        return messages
    }

    // Benchmark methods
    async runBenchmarks() {
        // Reduced test sizes to avoid memory issues
        // Still large enough for meaningful benchmarks
        const testSizes = [{ messages: 20000, charsPerMsg: 10000 }]

        console.log('======Starting benchmarks======')

        for (const size of testSizes) {
            const totalChars = size.messages * size.charsPerMsg
            console.log(`==== Test: ${size.messages} messages, ~${totalChars} total characters ====`)

            const testData = this.generateTestData(size.messages, size.charsPerMsg)

            // Run benchmarks sequentially
            const conversationId = this.generatePrefixedId('conv')
            const historyId = this.generatePrefixedId('his')
            const randomBinary = Math.round(Math.random())
            // Put SQLite before LokiJS because LokiJS will directly modify the in memory testData
            this.benchmarkSQLite(testData, conversationId, historyId, randomBinary)
            await this.benchmarkLokiJS(testData, conversationId, historyId, randomBinary)
        }
    }

    /**
     * Creates a deep copy of an object without using JSON.stringify/parse
     * which can fail with "Invalid string length" for large objects
     * @param obj The object to copy
     * @returns A deep copy of the object
     */
    deepCopy<T>(obj: T): T {
        // Handle null or undefined
        if (obj === null || obj === undefined) {
            return obj
        }

        // Handle primitive types (string, number, boolean)
        if (typeof obj !== 'object') {
            return obj
        }

        // Handle Date objects
        if (obj instanceof Date) {
            return new Date(obj.getTime()) as unknown as T
        }

        // Handle Array objects
        if (Array.isArray(obj)) {
            // For large arrays of simple objects, use map with spread operator
            // This is much more efficient than recursively copying each element
            return obj.map(item => {
                if (typeof item === 'object' && item !== null) {
                    // For objects within the array, create a shallow copy
                    // This avoids deep recursion which can cause stack overflow
                    return { ...item }
                }
                return item
            }) as unknown as T
        }

        // Handle Object objects
        const copy = {} as Record<string, any>
        for (const key in obj) {
            if (Object.prototype.hasOwnProperty.call(obj, key)) {
                const val = (obj as Record<string, any>)[key]

                // For large string values, don't try to deep copy
                if (typeof val === 'string' && val.length > 10000) {
                    copy[key] = val // Direct reference for large strings
                } else if (typeof val === 'object' && val !== null) {
                    // For small objects, create a shallow copy
                    copy[key] = { ...val }
                } else {
                    copy[key] = val
                }
            }
        }

        return copy as T
    }

    // Implement specific benchmark methods below
    /**
     * Counts the total number of messages across all histories in LokiJS
     * @returns The total message count
     */
    countTotalLokiJSMessages(historyCollection: Collection<any>): number {
        let totalMessages = 0
        try {
            const allHistories = historyCollection.find()

            if (allHistories && allHistories.length > 0) {
                // Use for loops instead of forEach to avoid potential callback issues with large arrays
                for (let i = 0; i < allHistories.length; i++) {
                    const history = allHistories[i]
                    if (history.conversations && history.conversations.length > 0) {
                        for (let j = 0; j < history.conversations.length; j++) {
                            const conversation = history.conversations[j]
                            if (conversation.messages && conversation.messages.length > 0) {
                                totalMessages += conversation.messages.length
                            }
                        }
                    }
                }
            }
        } catch (error) {
            console.error(`Error counting LokiJS messages: ${error}`)
        }
        return totalMessages
    }

    async benchmarkLokiJS(testData: any[], conversationId: string, historyId: string, isOpen: number) {
        console.log('====== LokiJS Benchmark: ======')

        // Create history collection that will contain conversations with messages
        let historyCollection = this.getOrInitialize()
        // Count total messages in LokiJS
        const totalLokiJSMessages = this.countTotalLokiJSMessages(historyCollection)
        console.log(`Total messages in LokiJS: ${totalLokiJSMessages}`)

        // Group messages by historyId and conversationId
        const history = {
            historyId: historyId,
            isOpen: isOpen,
            title: 'Test History',
            workspacePath: '/test/workspace',
            updatedAt: new Date().toISOString(),
            conversations: [
                {
                    conversationId: conversationId,
                    messages: testData,
                    lastUpdated: new Date().toISOString(),
                    title: 'Untitled conversation',
                    tabType: 'cwc',
                    clientType: 'IDE',
                },
            ],
        }

        // 1. Test write performance
        const writeStart = performance.now()
        // Insert history record
        historyCollection.insert(history)
        const writeEnd = performance.now()

        // 2. Test read performance
        const readStart = performance.now()
        // Read all open tabs with their conversations and messages
        const openHistories = historyCollection.find({ isOpen: 1 })
        console.log(`Found ${openHistories.length} open histories`)
        const readEnd = performance.now()

        const readSpecificMessageStart = performance.now()
        let specificMessageFound = false
        let specificMessage = null
        // Search for the message with ID 'msg-to-delete'
        const historiesWithTargetMessage = historyCollection.where((history: any) => {
            if (!history.conversations) return false

            return history.conversations.some((conversation: any) => {
                if (!conversation.messages) return false

                return conversation.messages.some((message: any) => {
                    return message.messageId === 'msg-to-delete'
                })
            })
        })
        if (historiesWithTargetMessage && historiesWithTargetMessage.length > 0) {
            // Find the specific message
            for (const history of historiesWithTargetMessage) {
                // if (specificMessageFound) break

                if (history.conversations && history.conversations.length > 0) {
                    for (const conversation of history.conversations) {
                        // if (specificMessageFound) break

                        if (conversation.messages && conversation.messages.length > 0) {
                            for (const message of conversation.messages) {
                                if (message.messageId === 'msg-to-delete') {
                                    specificMessage = message
                                    specificMessageFound = true
                                    // break
                                }
                            }
                        }
                    }
                }
            }
        }
        if (specificMessage) {
            console.log(`Found specific message with ID: msg-to-delete, content length: ${specificMessage.body.length}`)
        } else {
            console.log('Specific message with ID "msg-to-delete" not found')
        }
        const readSpecificMessageEnd = performance.now()

        // 3. Test query performance
        // Search for 'targetstring' among all messages
        const queryStart = performance.now()
        const searchTermLower = 'targetstring'
        const searchResults = historyCollection.find().filter((history: any) => {
            return history.conversations.some((conversation: any) => {
                return conversation.messages.some((message: any) => {
                    return message.body?.toLowerCase().includes(searchTermLower)
                })
            })
        })
        console.log(`Found ${searchResults.length} history for '${searchTermLower}' (case-insensitive)`)
        const queryEnd = performance.now()

        // 4. Test delete oldest message performance
        const deleteOldestMessageStart = performance.now()
        // Find all histories with messages
        const historiesWithMessages = historyCollection.find({ 'conversations.messages': { $size: { $gt: 0 } } })
        if (historiesWithMessages && historiesWithMessages.length > 0) {
            let oldestMessage: any = null
            let oldestTimestamp = Number.MAX_SAFE_INTEGER
            let oldestConversation: any = null
            let oldestHistory: any = null
            let oldestMessageIndex = -1
            // Iterate through all histories to find the oldest message
            for (const history of historiesWithMessages) {
                if (history.conversations && history.conversations.length > 0) {
                    for (const conversation of history.conversations) {
                        if (conversation.messages && conversation.messages.length > 0) {
                            for (let i = 0; i < conversation.messages.length; i++) {
                                const message = conversation.messages[i]
                                const messageTimestamp = new Date(message.timestamp).getTime()

                                if (messageTimestamp < oldestTimestamp) {
                                    oldestTimestamp = messageTimestamp
                                    oldestMessage = message
                                    oldestConversation = conversation
                                    oldestHistory = history
                                    oldestMessageIndex = i
                                }
                            }
                        }
                    }
                }
            }

            if (oldestMessage && oldestConversation && oldestHistory && oldestMessageIndex !== -1) {
                // Remove the oldest message
                console.log(
                    `Deleting oldest message with ID: ${oldestMessage.messageId} from conversation ${oldestConversation.conversationId}, timestamp: ${new Date(oldestTimestamp).toISOString()}`
                )
                oldestConversation.messages.splice(oldestMessageIndex, 1)
                historyCollection.update(oldestHistory)
            } else {
                console.log('No messages found to delete')
            }
        } else {
            console.log('No histories with messages found')
        }
        const deleteOldestMessageEnd = performance.now()

        // 5. Test delete specific message performance
        const deleteSpecificMessageStart = performance.now()
        // Find all histories with messages
        let messageFound = false
        // Search for histories that contain a message with ID 'msg-to-delete'
        const historiesWithSpecificMessage = historyCollection.where((history: any) => {
            if (!history.conversations) return false

            return history.conversations.some((conversation: any) => {
                if (!conversation.messages) return false

                return conversation.messages.some((message: any) => {
                    return message.messageId === 'msg-to-delete'
                })
            })
        })

        if (historiesWithSpecificMessage && historiesWithSpecificMessage.length > 0) {
            // Iterate through all histories to find the message with ID 'msg-to-delete'
            for (const history of historiesWithSpecificMessage) {
                if (messageFound) break

                if (history.conversations && history.conversations.length > 0) {
                    for (const conversation of history.conversations) {
                        if (messageFound) break

                        if (conversation.messages && conversation.messages.length > 0) {
                            for (let i = 0; i < conversation.messages.length; i++) {
                                const message = conversation.messages[i]

                                if (message.messageId === 'msg-to-delete') {
                                    // Found the message to delete
                                    console.log(
                                        `Found message with ID: msg-to-delete in conversation ${conversation.conversationId}`
                                    )
                                    console.log(
                                        `Deleting message with ID: msg-to-delete from conversation ${conversation.conversationId}`
                                    )
                                    conversation.messages.splice(i, 1)
                                    historyCollection.update(history)
                                    messageFound = true
                                    break
                                }
                            }
                        }
                    }
                }
            }

            if (!messageFound) {
                console.log('Message with ID "msg-to-delete" not found in any conversation')
            }
        } else {
            console.log('No histories with message "msg-to-delete" found')
        }
        const deleteSpecificMessageEnd = performance.now()

        // 6. Manual save database(this should be async, but just to understand the performance)
        const saveStart = performance.now()
        console.log('Save database')
        // Convert callback to Promise for saveDatabase
        await new Promise<void>((resolve, reject) => {
            this.#lokiDb.saveDatabase(err => {
                if (err) {
                    console.error(`Error saving database: ${err}`)
                    reject(err)
                } else {
                    console.log(`Database saved successfully to ${this.lokijsPath}`)
                    resolve()
                }
            })
        })
        const saveEnd = performance.now()

        // 7. Manual load database(mock initialization)
        console.log('Loading database...')
        const loadStart = performance.now()
        // Convert callback to Promise for loadDatabase
        await new Promise<void>((resolve, reject) => {
            this.#lokiDb.loadDatabase({}, err => {
                if (err) {
                    console.error(`Error loading database: ${err}`)
                    reject(err)
                } else {
                    console.log('Database loaded successfully')
                    // Initialize collection after loading
                    historyCollection = this.getOrInitialize()
                    resolve()
                }
            })
        })
        const loadEnd = performance.now()

        // Check file size
        const fileSize = this.checkFileSize(this.lokijsPath)
        // Count total messages in LokiJS
        const totalLokiJSMessagesAfter = this.countTotalLokiJSMessages(historyCollection)

        // Report results
        console.log('====== LokiJS benchmark results ======')
        console.log(`Total messages in LokiJS: ${totalLokiJSMessagesAfter}`)
        console.log(`Write time: ${(writeEnd - writeStart).toFixed(2)}ms`)
        console.log(`Read open history time: ${(readEnd - readStart).toFixed(2)}ms`)
        console.log(`Read specific message time: ${(readSpecificMessageEnd - readSpecificMessageStart).toFixed(2)}ms`)
        console.log(`Search message time: ${(queryEnd - queryStart).toFixed(2)}ms`)
        console.log(
            `Delete the oldest message time: ${(deleteOldestMessageEnd - deleteOldestMessageStart).toFixed(2)}ms`
        )
        console.log(
            `Delete specific message time: ${(deleteSpecificMessageEnd - deleteSpecificMessageStart).toFixed(2)}ms`
        )
        console.log(`Database save time: ${(saveEnd - saveStart).toFixed(2)}ms`)
        console.log(`Database load time: ${(loadEnd - loadStart).toFixed(2)}ms`)
        console.log(`File size: ${(fileSize / 1024).toFixed(2)} KB`)
    }

    benchmarkSQLite(testData: any[], conversationId: string, historyId: string, isOpen: number) {
        console.log('====== SQLite Benchmark: ======')

        this.createSQLiteTables()

        // Count total messages in the database
        const totalMessagesResult = this.#sqliteDb.prepare('SELECT COUNT(*) as count FROM messages').get() as {
            count: number
        }
        console.log(`Total messages in SQLite: ${totalMessagesResult.count}`)

        // 1. Test write performance
        const writeStart = performance.now()
        // Create a test history
        this.#sqliteDb
            .prepare(
                'INSERT INTO history (history_id, workspace_path, is_open, title, updated_at) VALUES (?, ?, ?, ?, ?)'
            )
            .run(historyId, '/test/workspace', isOpen, 'Test History', new Date().toISOString())
        // Create a test conversation
        this.#sqliteDb
            .prepare(
                `
                INSERT INTO conversations (conversation_id, history_id, updated_at, tab_type, client_type)
                VALUES (?, ?, ?, ?, ?)
            `
            )
            .run(conversationId, historyId, new Date().toISOString(), 'cwc', 'IDE')
        // Prepare statement for inserting messages
        const insertStmt = this.#sqliteDb.prepare(`
                INSERT INTO messages (messageId, conversation_id, content, chat_message, created_at, context)
                VALUES (?, ?, ?, ?, ?, ?)
            `)
        // Begin transaction for better performance with multiple inserts
        const insertMany = this.#sqliteDb.transaction(messages => {
            for (const message of messages) {
                insertStmt.run(
                    message.messageId,
                    conversationId,
                    message.body,
                    message.type,
                    message.timestamp,
                    JSON.stringify(message.userInputMessageContext)
                )
            }
        })
        // Execute the transaction with all messages
        insertMany(testData)
        // Add this line to ensure the transaction is committed
        // this.ensureSqliteWritesFlushedToDb()
        const writeEnd = performance.now()

        // 2. Test read performance
        // Read all open tabs
        const readStart = performance.now()
        const completeOpenHistories = this.#sqliteDb
            .prepare(
                `
                    SELECT DISTINCT
                        h.history_id, c.conversation_id
                    FROM history h
                    JOIN conversations c ON h.history_id = c.history_id
                    JOIN messages m ON c.conversation_id = m.conversation_id
                    WHERE h.is_open = 1
                    ORDER BY h.updated_at DESC, c.updated_at DESC, m.created_at ASC
                `
            )
            .all()
        console.log(`Retrieved ${completeOpenHistories.length} open histories`)
        const readEnd = performance.now()

        // Test reading a specific message by ID
        const readSpecificMessageStart = performance.now()
        try {
            // Find the specific message with ID 'msg-to-delete'
            const specificMessage = this.#sqliteDb
                .prepare(
                    `
                    SELECT m.messageId, m.conversation_id, m.content, m.created_at, c.history_id, h.title
                    FROM messages m
                    JOIN conversations c ON m.conversation_id = c.conversation_id
                    JOIN history h ON c.history_id = h.history_id
                    WHERE m.messageId = ?
                    `
                )
                .get('msg-to-delete')

            if (specificMessage) {
                // Type assertion to help TypeScript understand the structure
                const typedMessage = specificMessage as {
                    messageId: string
                    conversation_id: string
                    content: string
                    created_at: string
                    history_id: string
                    title: string
                }

                console.log(
                    `Found specific message with ID: msg-to-delete, content length: ${typedMessage.content.length}`
                )
                console.log(
                    `Message belongs to conversation ${typedMessage.conversation_id} in history "${typedMessage.title}"`
                )
            } else {
                console.log('Specific message with ID "msg-to-delete" not found')
            }
        } catch (error) {
            const readError = error as Error
            console.error(`Error reading specific message: ${readError.message}`)
        }
        const readSpecificMessageEnd = performance.now()

        // 3. Test query performance
        const queryStart = performance.now()
        // Fetch all history, conversation, and message fields
        // where message content contains 'targetstring' (case-insensitive)
        const searchTerm = 'targetstring'
        const searchResults = this.#sqliteDb
            .prepare(
                `
                SELECT DISTINCT h.history_id
                FROM messages m
                JOIN conversations c ON m.conversation_id = c.conversation_id
                JOIN history h ON c.history_id = h.history_id
                WHERE LOWER(m.content) LIKE LOWER(?)
                ORDER BY h.updated_at DESC
                `
            )
            .all(`%${searchTerm}%`)
        console.log(`Found ${searchResults.length} history containing '${searchTerm}' (case-insensitive)`)
        const queryEnd = performance.now()

        // 4. Test delete oldest message performance
        const deleteOldestMessageStart = performance.now()
        try {
            // Find the oldest message across all conversations based on created_at timestamp
            const oldestMessage = this.#sqliteDb
                .prepare(
                    `
                    SELECT m.messageId, m.conversation_id, m.created_at, c.history_id
                    FROM messages m
                    JOIN conversations c ON m.conversation_id = c.conversation_id
                    ORDER BY m.created_at ASC
                    LIMIT 1
                    `
                )
                .get()

            if (oldestMessage) {
                // Type assertion to help TypeScript understand the structure
                const typedMessage = oldestMessage as {
                    messageId: string
                    conversation_id: string
                    created_at: string
                }

                console.log(
                    `Deleting oldest message with ID: ${typedMessage.messageId} from conversation ${typedMessage.conversation_id}, timestamp: ${typedMessage.created_at}`
                )
                // Delete the message
                this.#sqliteDb.prepare('DELETE FROM messages WHERE messageId = ?').run(typedMessage.messageId)
                console.log('Oldest message deleted successfully')
            } else {
                console.log('No messages found to delete')
            }
        } catch (error) {
            const deleteError = error as Error
            console.error(`Error deleting message: ${deleteError.message}`)
        }
        const deleteOldestMessageEnd = performance.now()

        // 5. Test delete specific message performance
        const deleteSpecificMessageStart = performance.now()
        try {
            // Delete the message
            this.#sqliteDb.prepare('DELETE FROM messages WHERE messageId = ?').run('msg-to-delete')
            console.log('Specific message deleted successfully')
        } catch (error) {
            const deleteError = error as Error
            console.error(`Error deleting message: ${deleteError.message}`)
        }
        const deleteSpecificMessageEnd = performance.now()

        // Check file size
        const fileSize = this.checkFileSize(this.sqlitePath)

        // Count total messages in SQLite again after deletions
        const finalMessageCount = this.#sqliteDb.prepare('SELECT COUNT(*) as count FROM messages').get() as {
            count: number
        }

        // Report results
        console.log('====== SQLite benchmark results ======')
        console.log(`Total messages in SQLite: ${finalMessageCount.count}`)
        console.log(`Write time: ${(writeEnd - writeStart).toFixed(2)}ms`)
        console.log(`Read open history time: ${(readEnd - readStart).toFixed(2)}ms`)
        console.log(`Read specific message time: ${(readSpecificMessageEnd - readSpecificMessageStart).toFixed(2)}ms`)
        console.log(`Search message time: ${(queryEnd - queryStart).toFixed(2)}ms`)
        console.log(`Delete oldest message time: ${(deleteOldestMessageEnd - deleteOldestMessageStart).toFixed(2)}ms`)
        console.log(
            `Delete specific message time: ${(deleteSpecificMessageEnd - deleteSpecificMessageStart).toFixed(2)}ms`
        )
        console.log(`File size: ${(fileSize / 1024).toFixed(2)} KB`)
    }

    private createSQLiteTables() {
        // Create tables if needed
        // Check if all required tables exist
        const historyExists = this.#sqliteDb
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='history'")
            .get()

        const conversationsExists = this.#sqliteDb
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='conversations'")
            .get()

        const messagesExists = this.#sqliteDb
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='messages'")
            .get()
        // Create tables if any of them don't exist
        if (!historyExists || !conversationsExists || !messagesExists) {
            console.log('Creating missing tables...')

            // Create history table if it doesn't exist
            if (!historyExists) {
                this.#sqliteDb.exec(`
                    CREATE TABLE history (
                        history_id TEXT PRIMARY KEY,
                        workspace_path TEXT NOT NULL,
                        is_open BOOLEAN NOT NULL DEFAULT 1,
                        title TEXT NOT NULL,
                        updated_at TIMESTAMP NOT NULL
                    );
                `)
            }

            // Create conversations table if it doesn't exist
            if (!conversationsExists) {
                this.#sqliteDb.exec(`
                    CREATE TABLE conversations (
                        conversation_id TEXT PRIMARY KEY,
                        history_id TEXT NOT NULL,
                        updated_at TIMESTAMP NOT NULL,
                        tab_type TEXT NOT NULL,
                        title TEXT,
                        client_type TEXT NOT NULL,
                        UNIQUE(history_id, conversation_id),
                        FOREIGN KEY (history_id) REFERENCES history(history_id) ON DELETE CASCADE
                    );
                `)
            }

            // Create messages table if it doesn't exist
            if (!messagesExists) {
                this.#sqliteDb.exec(`
                    CREATE TABLE messages (
                        messageId TEXT PRIMARY KEY,
                        conversation_id TEXT,
                        content TEXT NOT NULL,
                        chat_message TEXT,
                        chat_item TEXT,
                        created_at TEXT NOT NULL,
                        context TEXT,
                        UNIQUE(conversation_id, messageId),
                        FOREIGN KEY (conversation_id) REFERENCES conversations(conversation_id) ON DELETE CASCADE
                    );
                    
                    CREATE INDEX IF NOT EXISTS idx_messages_tab_id ON messages(conversation_id);
                    CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
                `)
            }

            // Create index on conversations if needed
            if (!conversationsExists) {
                this.#sqliteDb.exec(`
                    CREATE INDEX IF NOT EXISTS idx_conversations_history ON conversations(history_id);
                `)
            }
        }
    }

    private checkFileSize(dbPath: string) {
        // Check file size
        try {
            if (fs.existsSync(dbPath)) {
                return fs.statSync(dbPath).size
            } else {
                console.log(`File doesn't exist at: ${dbPath}`)
                return 0
            }
        } catch (e) {
            console.error(`Error checking file after save: ${e}`)
            return 0
        }
    }
}
