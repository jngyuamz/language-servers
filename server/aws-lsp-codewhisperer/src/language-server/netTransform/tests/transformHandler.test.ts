import { CodeWhispererStreaming } from '@aws/codewhisperer-streaming-client'
import {
    Logging,
    Workspace,
    SDKInitializator,
    SDKClientConstructorV2,
    SDKClientConstructorV3,
    Runtime,
} from '@aws/language-server-runtimes/server-interface'
import * as assert from 'assert'
import { HttpResponse } from 'aws-sdk'
import { expect } from 'chai'
import * as fs from 'fs'
import got from 'got'
import { StubbedInstance, default as simon, stubInterface } from 'ts-sinon'
import { StreamingClient, createStreamingClient } from '../../../client/streamingClient/codewhispererStreamingClient'
import { CodeWhispererServiceToken } from '../../../shared/codeWhispererService'
import {
    CancelTransformRequest,
    CancellationJobStatus,
    GetTransformPlanRequest,
    GetTransformRequest,
    StartTransformRequest,
} from '../models'
import { TransformHandler } from '../transformHandler'
import { EXAMPLE_REQUEST } from './mockData'
import sinon = require('sinon')
import { DEFAULT_AWS_Q_ENDPOINT_URL, DEFAULT_AWS_Q_REGION } from '../../../shared/constants'
import { Service } from 'aws-sdk'
import { ServiceConfigurationOptions } from 'aws-sdk/lib/service'
import { Readable } from 'stream'
import { ArtifactManager } from '../artifactManager'
import path = require('path')
import { IZipEntry } from 'adm-zip'
import { AmazonQTokenServiceManager } from '../../../shared/amazonQServiceManager/AmazonQTokenServiceManager'

const mocked$Response = {
    $response: {
        hasNextPage: simon.mock(),
        nextPage: simon.mock(),
        data: undefined,
        error: undefined,
        requestId: '',
        redirectCount: 0,
        retryCount: 0,
        httpResponse: new HttpResponse(),
    },
}
const testUploadId = 'test-upoload-id'
const testTransformId = 'test-transform-id'
const payloadFileName = 'C:\\test.zip'

describe('Test Transform handler ', () => {
    let client: StubbedInstance<CodeWhispererServiceToken>
    let workspace: StubbedInstance<Workspace>
    let runtime: StubbedInstance<Runtime>
    let transformHandler: TransformHandler
    const mockedLogging = stubInterface<Logging>()
    const awsQRegion: string = DEFAULT_AWS_Q_REGION
    const awsQEndpointUrl: string = DEFAULT_AWS_Q_ENDPOINT_URL
    beforeEach(async () => {
        // Set up the server with a mock service
        client = stubInterface<CodeWhispererServiceToken>()
        workspace = stubInterface<Workspace>()
        runtime = stubInterface<Runtime>()

        const serviceManager = stubInterface<AmazonQTokenServiceManager>()
        client = stubInterface<CodeWhispererServiceToken>()
        serviceManager.getCodewhispererService.returns(client)

        transformHandler = new TransformHandler(serviceManager, workspace, mockedLogging, runtime)
    })

    describe('test upload artifact', () => {
        it('call upload method correctly with stream', async () => {
            const putStub = sinon.stub(got, 'put').resolves({ statusCode: 200 })
            const createReadStreamStub = sinon.stub(fs, 'createReadStream').returns(new Readable() as fs.ReadStream)
            await transformHandler.uploadArtifactToS3Async(
                payloadFileName,
                {
                    uploadId: testUploadId,
                    uploadUrl: 'dummy-upload-url',
                    kmsKeyArn: 'ResourceArn',
                    ...mocked$Response,
                },
                'dummy-256'
            )
            sinon.assert.calledOnce(putStub)
            sinon.assert.calledOnce(createReadStreamStub)

            putStub.restore()
            createReadStreamStub.restore()
        })

        it('handles upload failure correctly', async () => {
            const putStub = sinon.stub(got, 'put').rejects(new Error('Upload failed'))
            const createReadStreamStub = sinon.stub(fs, 'createReadStream').returns(new Readable() as fs.ReadStream)

            try {
                await transformHandler.uploadArtifactToS3Async(
                    payloadFileName,
                    {
                        uploadId: testUploadId,
                        uploadUrl: 'dummy-upload-url',
                        kmsKeyArn: 'ResourceArn',
                        ...mocked$Response,
                    },
                    'dummy-256'
                )
                assert.fail('Should have thrown an error')
            } catch (error) {
                expect((error as Error).message).to.include('Upload failed')
                expect((error as Error).message).to.include(
                    'please see https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/troubleshooting-code-transformation.html'
                )
            } finally {
                putStub.restore()
                createReadStreamStub.restore()
            }
        })
    })

    describe('Test transform create presign url and upload', () => {
        beforeEach(async () => {
            // mock default return value for createUploadUrl
            client.codeModernizerCreateUploadUrl.resolves({
                uploadId: testUploadId,
                uploadUrl: 'dummy-upload-url',
                kmsKeyArn: 'ResourceArn',
                ...mocked$Response,
            })
        })

        it('returns upload id correctly with streaming', async () => {
            const createReadStreamStub = sinon.stub(fs, 'createReadStream').returns(new Readable() as fs.ReadStream)
            const uploadStub = sinon.stub(transformHandler, 'uploadArtifactToS3Async').resolves()
            const getSha256AsyncStub = sinon.stub(ArtifactManager, 'getSha256Async').resolves('dummy-sha256')
            const res = await transformHandler.uploadPayloadAsync(payloadFileName)

            sinon.assert.calledOnce(uploadStub)
            expect(res).to.equal(testUploadId)

            uploadStub.restore()
            createReadStreamStub.restore()
            getSha256AsyncStub.restore()
        })

        it('should throw error if uploadArtifactToS3Async fails', async () => {
            const mockError = new Error('Error in uploadArtifactToS3 call')
            const createReadStreamStub = sinon.stub(fs, 'createReadStream').returns(new Readable() as fs.ReadStream)
            const getSha256AsyncStub = sinon.stub(ArtifactManager, 'getSha256Async').resolves('dummy-sha256')
            sinon.stub(transformHandler, 'uploadArtifactToS3Async').rejects(mockError)

            // Call the method to be tested
            try {
                await transformHandler.uploadPayloadAsync(payloadFileName)
                assert.fail('Should have thrown an error')
            } catch (error) {
                // Assertions
                expect((error as Error).message).to.equal(mockError.message)
            } finally {
                createReadStreamStub.restore()
                getSha256AsyncStub.restore()
            }
        })
        /*
        it('should upload payload and return uploadId', async () => {
            workspace.fs.getTempDirPath = simon.stub().returns('C:\\tmp')
            const zipStub = sinon.stub(transformHandler, 'zipCodeAsync').returns(Promise.resolve(payloadFileName))
            const uploadStub = sinon.stub(transformHandler, 'uploadPayloadAsync').returns(Promise.resolve(testUploadId))
            const result = await transformHandler.preTransformationUploadCode(payloadFileName)
            expect(result).to.equal(testUploadId)
            sinon.assert.calledOnce(zipStub)
            sinon.assert.calledOnce(uploadStub)
            zipStub.restore()
            uploadStub.restore()
        })

        it('should throw error if upload fails', async () => {
            // Mocking necessary dependencies and methods
            const mockError = new Error('Upload failed')
            const requestString = JSON.stringify(EXAMPLE_REQUEST)
            const request = JSON.parse(requestString) as StartTransformRequest
            workspace.fs.getTempDirPath = simon.stub().returns('C:\\tmp')
            const zipStub = sinon.stub(transformHandler, 'zipCodeAsync').returns(Promise.resolve(payloadFileName))
            sinon.stub(transformHandler, 'uploadPayloadAsync').rejects(mockError)
            try {
                await transformHandler.preTransformationUploadCode(request)
            } catch (error) {
                sinon.assert.calledOnce(zipStub)
                expect((error as Error).message).to.equal(mockError.message)
                zipStub.restore()
            }
        })
            */
    })

    describe('Test cancel transform job', () => {
        beforeEach(async () => {
            // mock default return value for cancelTransform
            client.codeModernizerStopCodeTransformation.returns(
                Promise.resolve({
                    transformationStatus: 'STOPPED',
                    ...mocked$Response,
                })
            )
        })

        it('should cancel transform', async () => {
            const requestString = JSON.stringify({ TransformationJobId: testTransformId })
            const request = JSON.parse(requestString) as CancelTransformRequest
            const res = await transformHandler.cancelTransformation(request)

            expect(res.TransformationJobStatus).to.equal(CancellationJobStatus.SUCCESSFULLY_CANCELLED)
        })

        it('should throw error if cancellation fails', async () => {
            client.codeModernizerStopCodeTransformation.returns(
                Promise.resolve({
                    transformationStatus: 'COMPLETED',
                    ...mocked$Response,
                })
            )

            const requestString = JSON.stringify({ TransformationJobId: testTransformId })
            const request = JSON.parse(requestString) as CancelTransformRequest
            const res = await transformHandler.cancelTransformation(request)

            expect(res.TransformationJobStatus).to.equal(CancellationJobStatus.FAILED_TO_CANCEL)
        })
    })
    const mockedCredentialsProvider = {
        getCredentials: sinon.stub().returns({ token: 'mockedToken' }),
    }

    const mockSdkInitializator: SDKInitializator = Object.assign(
        // Default callable function for v3 clients
        <T, P>(Ctor: SDKClientConstructorV3<T, P>, current_config: P): T => new Ctor({ ...current_config }),
        // Property for v2 clients
        {
            v2: <T extends Service, P extends ServiceConfigurationOptions>(
                Ctor: SDKClientConstructorV2<T, P>,
                current_config: P
            ): T => new Ctor({ ...current_config }),
        }
    )

    describe('StreamingClient', () => {
        it('should create a new streaming client', async () => {
            const streamingClient = new StreamingClient()
            const client = await streamingClient.getStreamingClient(
                mockedCredentialsProvider,
                awsQRegion,
                awsQEndpointUrl,
                mockSdkInitializator,
                mockedLogging
            )
            expect(client).to.be.instanceOf(CodeWhispererStreaming)
        })
    })

    describe('createStreamingClient', () => {
        it('should create a new streaming client with correct configurations', async () => {
            const client = await createStreamingClient(
                mockedCredentialsProvider,
                awsQRegion,
                awsQEndpointUrl,
                mockSdkInitializator,
                mockedLogging
            )
            expect(client).to.be.instanceOf(CodeWhispererStreaming)
        })
    })

    describe('Test get transformJob', () => {
        beforeEach(async () => {
            // mock default return value for Transformation Job
            client.codeModernizerGetCodeTransformation.returns(
                Promise.resolve({
                    transformationJob: {
                        jobId: testTransformId,
                        status: 'COMPLETED',
                        ...mocked$Response,
                    },
                    ...mocked$Response,
                })
            )
        })

        it('should get transform', async () => {
            const requestString = JSON.stringify({ TransformationJobId: testTransformId })
            const request = JSON.parse(requestString) as GetTransformRequest
            const res = await transformHandler.getTransformation(request)

            expect(res?.TransformationJob.status).to.equal('COMPLETED')
        })
    })

    describe('Test get transformJob for failed case', () => {
        beforeEach(async () => {
            // mock default return value for Transformation Job
            client.codeModernizerGetCodeTransformation.returns(
                Promise.resolve({
                    transformationJob: {
                        jobId: testTransformId,
                        status: 'FAILED',
                        ...mocked$Response,
                    },
                    ...mocked$Response,
                })
            )
        })

        it('should get transform for failed case', async () => {
            const requestString = JSON.stringify({ TransformationJobId: testTransformId })
            const request = JSON.parse(requestString) as GetTransformRequest
            const res = await transformHandler.getTransformation(request)

            expect(res?.TransformationJob.status).to.equal('FAILED')
        })
    })

    describe('Test get transform plan', () => {
        beforeEach(async () => {
            // mock default return value for Transformation plan

            const mockPlanString = JSON.stringify({
                transformationPlan: {
                    transformationSteps: [
                        {
                            id: '1',
                            name: 'PlanStepName 1',
                            description: 'PlanStepDescription 1',
                            status: 'COMPLETED',
                            progressUpdates: [
                                {
                                    name: 'ProgressUpdateName 1 for PlanStep 1',
                                    status: 'COMPLETED',
                                    description: 'ProgressUpdateDescription 1 for PlanStep 1',
                                    startTime: '2024-03-11T23:27:33.935Z',
                                    endTime: '2024-03-11T23:27:34.038Z',
                                },
                            ],
                            startTime: '2024-03-12T18:49:41.431Z',
                            endTime: '2024-03-12T18:49:42.431Z',
                        },
                    ],
                },
            })
            const response = JSON.parse(mockPlanString)
            client.codeModernizerGetCodeTransformationPlan.returns(Promise.resolve(response))
        })

        it('should get transform plan', async () => {
            const requestString = JSON.stringify({ TransformationJobId: testTransformId })
            const request = JSON.parse(requestString) as GetTransformPlanRequest
            const res = await transformHandler.getTransformationPlan(request)

            expect(res.TransformationPlan.transformationSteps[0].status).to.equal('COMPLETED')
            expect(res.TransformationPlan.transformationSteps[0].name).to.equal('PlanStepName 1')
            if (res.TransformationPlan.transformationSteps[0].progressUpdates) {
                expect(res.TransformationPlan.transformationSteps[0].progressUpdates[0].name).to.equal(
                    'ProgressUpdateName 1 for PlanStep 1'
                )
            }
        })
    })

    describe('Test extract all tntries to a path', () => {
        let sandbox: sinon.SinonSandbox
        let mkdirStub: sinon.SinonStub
        let writeFileStub: sinon.SinonStub

        beforeEach(() => {
            sandbox = sinon.createSandbox()

            sandbox.stub(path, 'join').callsFake((...args) => args.join('/'))
            sandbox.stub(path, 'dirname').callsFake(p => p.split('/').slice(0, -1).join('/'))
            mkdirStub = sinon.stub(fs.promises, 'mkdir')
            writeFileStub = sinon.stub(fs.promises, 'writeFile')
        })

        afterEach(() => {
            sandbox.restore()
            if (mkdirStub?.restore) {
                mkdirStub.restore()
            }
            if (writeFileStub?.restore) {
                writeFileStub.restore()
            }
        })

        function createMockZipEntry(entryName: string, isDirectory: boolean, content?: string): IZipEntry {
            return {
                entryName,
                isDirectory,
                getData: content ? () => Buffer.from(content) : () => Buffer.from(''),
                header: {} as any,
                attr: 0,
                getCompressedData: () => Buffer.from(''),
                name: entryName,
                rawEntryName: Buffer.from(entryName),
                extra: Buffer.from(''),
                comment: '',
                getCompressedDataAsync: function (callback: (data: Buffer) => void): void {
                    throw new Error('Function not implemented.')
                },
                setData: function (value: string | Buffer): void {
                    throw new Error('Function not implemented.')
                },
                getDataAsync: function (callback: (data: Buffer, err: string) => void): void {
                    throw new Error('Function not implemented.')
                },
                packHeader: function (): Buffer {
                    throw new Error('Function not implemented.')
                },
                toString: function (): string {
                    throw new Error('Function not implemented.')
                },
            }
        }

        it('should create directories and extract files successfully', async () => {
            const pathContainingArchive = '/test/path'
            const zipEntries = [
                createMockZipEntry('dir1/', true),
                createMockZipEntry('dir1/file1.txt', false, 'content1'),
                createMockZipEntry('file2.txt', false, 'content2'),
            ]

            await transformHandler.extractAllEntriesTo(pathContainingArchive, zipEntries)

            sinon.assert.calledThrice(mkdirStub)
            sinon.assert.calledTwice(writeFileStub)
        })

        it('should handle ENOENT errors gracefully', async () => {
            const pathContainingArchive = '/test/path'
            const enoentError = new Error('ENOENT') as NodeJS.ErrnoException
            enoentError.code = 'ENOENT'

            const zipEntries = [createMockZipEntry('file1.txt', false)]
            zipEntries[0].getData = () => {
                throw enoentError
            }

            await transformHandler.extractAllEntriesTo(pathContainingArchive, zipEntries)
            expect(mockedLogging.log.args.flat()).to.include(
                'Attempted to extract a file that does not exist : file1.txt'
            )
        })

        it('should throw non-ENOENT errors', async () => {
            const pathContainingArchive = '/test/path'
            const otherError = new Error('Some other error')

            const zipEntries = [createMockZipEntry('file1.txt', false)]
            zipEntries[0].getData = () => {
                throw otherError
            }

            return transformHandler
                .extractAllEntriesTo(pathContainingArchive, zipEntries)
                .then(() => {
                    expect.fail('Expected "Some other error" to be thrown, but no error was thrown.')
                })
                .catch(error => {
                    expect(error.message).to.equal('Some other error')
                })
        })

        it('should handle nested directory structures', async () => {
            const pathContainingArchive = '/test/path'
            const zipEntries = [
                createMockZipEntry('dir1/', true),
                createMockZipEntry('dir1/dir2/', true),
                createMockZipEntry('dir1/dir2/file1.txt', false, 'content1'),
            ]

            await transformHandler.extractAllEntriesTo(pathContainingArchive, zipEntries)

            sinon.assert.calledThrice(mkdirStub)
            sinon.assert.calledOnce(writeFileStub)
            sinon.assert.calledWith(writeFileStub, '/test/path/dir1/dir2/file1.txt')
        })

        it('should handle empty entry list', async () => {
            const pathContainingArchive = '/test/path'
            const zipEntries: IZipEntry[] = []

            await transformHandler.extractAllEntriesTo(pathContainingArchive, zipEntries)

            sinon.assert.notCalled(mkdirStub)
            sinon.assert.notCalled(writeFileStub)
        })

        it('should handle files without directories', async () => {
            const pathContainingArchive = '/test/path'
            const zipEntries = [
                createMockZipEntry('file1.txt', false, 'content1'),
                createMockZipEntry('file2.txt', false, 'content2'),
            ]

            await transformHandler.extractAllEntriesTo(pathContainingArchive, zipEntries)

            sinon.assert.calledTwice(mkdirStub)
            sinon.assert.calledTwice(writeFileStub)
        })

        it('should handle mixed content with files and directories', async () => {
            const pathContainingArchive = '/test/path'
            const zipEntries = [
                createMockZipEntry('dir1/', true),
                createMockZipEntry('file1.txt', false, 'content1'),
                createMockZipEntry('dir1/file2.txt', false, 'content2'),
            ]

            await transformHandler.extractAllEntriesTo(pathContainingArchive, zipEntries)

            sinon.assert.calledThrice(mkdirStub)
            sinon.assert.calledTwice(writeFileStub)
            sinon.assert.calledWith(mkdirStub, '/test/path/dir1')
        })

        it('should handle invalid entry paths', async () => {
            const pathContainingArchive = '/test/path'
            const invalidError = new Error('Invalid path') as NodeJS.ErrnoException
            invalidError.code = 'EINVAL'

            const zipEntries = [createMockZipEntry('invalid/../../file.txt', false, 'content')]

            ;(fs.promises.mkdir as sinon.SinonStub).rejects(invalidError)

            return transformHandler
                .extractAllEntriesTo(pathContainingArchive, zipEntries)
                .then(() => {
                    expect.fail('Expected "Invalid path" to be thrown, but no error was thrown.')
                })
                .catch(error => {
                    expect(error.message).to.equal('Invalid path')
                })
        })
    })
})
