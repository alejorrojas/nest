import { RequestMethod } from '@nestjs/common';
import { expect, use } from 'chai';
import * as chaiAsPromised from 'chai-as-promised';
import { EventEmitter } from 'events';
import { ApplicationConfig } from '../application-config';
import { NestContainer } from '../injector/container';
import { GraphInspector } from '../inspector/graph-inspector';
import { NestApplication } from '../nest-application';
import { mapToExcludeRoute } from './../middleware/utils';
import { NoopHttpAdapter } from './utils/noop-adapter.spec';
import { MicroserviceOptions } from '@nestjs/microservices';
import * as sinon from 'sinon';

use(chaiAsPromised);

describe('NestApplication', () => {
  describe('Hybrid Application', () => {
    class Interceptor {
      public intercept(context, next) {
        return next();
      }
    }
    it('default should use new ApplicationConfig', () => {
      const applicationConfig = new ApplicationConfig();
      const container = new NestContainer(applicationConfig);
      const instance = new NestApplication(
        container,
        new NoopHttpAdapter({}),
        applicationConfig,
        new GraphInspector(container),
        {},
      );
      instance.useGlobalInterceptors(new Interceptor());
      const microservice = instance.connectMicroservice<MicroserviceOptions>(
        {},
      );
      expect((instance as any).config.getGlobalInterceptors().length).to.equal(
        1,
      );
      expect(
        (microservice as any).applicationConfig.getGlobalInterceptors().length,
      ).to.equal(0);
    });
    it('should inherit existing ApplicationConfig', () => {
      const applicationConfig = new ApplicationConfig();
      const container = new NestContainer(applicationConfig);
      const instance = new NestApplication(
        container,
        new NoopHttpAdapter({}),
        applicationConfig,
        new GraphInspector(container),
        {},
      );
      instance.useGlobalInterceptors(new Interceptor());
      const microservice = instance.connectMicroservice<MicroserviceOptions>(
        {},
        { inheritAppConfig: true },
      );
      expect((instance as any).config.getGlobalInterceptors().length).to.equal(
        1,
      );
      expect(
        (microservice as any).applicationConfig.getGlobalInterceptors().length,
      ).to.equal(1);
    });

    it('should immediately initialize microservice by default', () => {
      const applicationConfig = new ApplicationConfig();
      const container = new NestContainer(applicationConfig);
      const instance = new NestApplication(
        container,
        new NoopHttpAdapter({}),
        applicationConfig,
        new GraphInspector(container),
        {},
      );

      const microservice = instance.connectMicroservice<MicroserviceOptions>(
        {},
        {},
      );

      expect((microservice as any).isInitialized).to.be.true;
      expect((microservice as any).wasInitHookCalled).to.be.true;
    });

    it('should defer microservice initialization when deferInitialization is true', () => {
      const applicationConfig = new ApplicationConfig();
      const container = new NestContainer(applicationConfig);
      const instance = new NestApplication(
        container,
        new NoopHttpAdapter({}),
        applicationConfig,
        new GraphInspector(container),
        {},
      );

      const microservice = instance.connectMicroservice<MicroserviceOptions>(
        {},
        { deferInitialization: true },
      );

      expect((microservice as any).isInitialized).to.be.false;
      expect((microservice as any).wasInitHookCalled).to.be.false;
    });
  });
  describe('Global Prefix', () => {
    it('should get correct global prefix options', () => {
      const applicationConfig = new ApplicationConfig();
      const container = new NestContainer(applicationConfig);
      const instance = new NestApplication(
        container,
        new NoopHttpAdapter({}),
        applicationConfig,
        new GraphInspector(container),
        {},
      );
      const excludeRoute = ['foo', { path: 'bar', method: RequestMethod.GET }];
      instance.setGlobalPrefix('api', {
        exclude: excludeRoute,
      });
      expect(applicationConfig.getGlobalPrefixOptions()).to.eql({
        exclude: mapToExcludeRoute(excludeRoute),
      });
    });
  });
  describe('Double initialization', () => {
    it('should initialize application only once', async () => {
      const noopHttpAdapter = new NoopHttpAdapter({});
      const httpAdapterSpy = sinon.spy(noopHttpAdapter);

      const applicationConfig = new ApplicationConfig();

      const container = new NestContainer(applicationConfig);
      container.setHttpAdapter(noopHttpAdapter);

      const instance = new NestApplication(
        container,
        noopHttpAdapter,
        applicationConfig,
        new GraphInspector(container),
        {},
      );

      await instance.init();
      await instance.init();

      expect(httpAdapterSpy.init.calledOnce).to.be.true;
    });
  });

  describe('Auto listen', () => {
    class FakeHttpServer extends EventEmitter {
      public boundPort: number | undefined;

      constructor(private readonly busyPorts = new Map<number, number>()) {
        super();
      }

      listen(port: any, ...args: any[]) {
        let callback: Function | undefined;
        if (typeof args[args.length - 1] === 'function') {
          callback = args.pop();
        }

        const numericPort =
          typeof port === 'number' ? port : Number(port ?? NaN);

        setImmediate(() => {
          const attemptsLeft = this.busyPorts.get(numericPort) ?? 0;
          if (attemptsLeft > 0) {
            this.busyPorts.set(numericPort, attemptsLeft - 1);
            const error = new Error('EADDRINUSE') as NodeJS.ErrnoException;
            error.code = 'EADDRINUSE';
            this.emit('error', error);
            return;
          }

          this.boundPort = numericPort;
          callback?.();
        });

        return this;
      }

      address() {
        if (typeof this.boundPort !== 'number') {
          return undefined;
        }
        return {
          address: '127.0.0.1',
          family: 'IPv4',
          port: this.boundPort,
        };
      }
    }

    class RetryHttpAdapter extends NoopHttpAdapter {
      constructor(private readonly server: FakeHttpServer) {
        super(server);
        this.setHttpServer(server);
      }

      override initHttpServer(): any {
        this.setHttpServer(this.getInstance());
      }

      override listen(port: any, ...args: any[]) {
        return this.server.listen(port, ...args);
      }
    }

    const createApplication = (
      autoListen: boolean | Record<string, any>,
      busyPorts: Map<number, number>,
    ) => {
      const applicationConfig = new ApplicationConfig();
      const container = new NestContainer(applicationConfig);
      const server = new FakeHttpServer(busyPorts);
      const adapter = new RetryHttpAdapter(server);

      container.setHttpAdapter(adapter);

      const appOptions =
        autoListen === undefined ? {} : { autoListen: autoListen as any };

      const app = new NestApplication(
        container,
        adapter,
        applicationConfig,
        new GraphInspector(container),
        appOptions,
      );

      (app as any).isInitialized = true;

      return { app, server };
    };

    it('should probe for the next port when current port is busy', async () => {
      const busyPorts = new Map<number, number>([[3000, 1]]);
      const { app, server } = createApplication(true, busyPorts);

      const logger = app['logger'];
      const logSpy = sinon.spy(logger, 'log');
      const errorStub = sinon.stub(logger, 'error');

      try {
        await app.listen(3000);
        expect(server.boundPort).to.equal(3001);

        expect(
          logSpy.calledWithMatch(
            /Port.*3000.*is in use.*trying.*3001.*instead/,
          ),
        ).to.be.true;
        expect(errorStub.called).to.be.false;
      } finally {
        logSpy.restore();
        errorStub.restore();
      }
    });

    it('should surface port in use error when autoListen is disabled', async () => {
      const busyPorts = new Map<number, number>([[3000, 1]]);
      const { app } = createApplication(false, busyPorts);
      const errorStub = sinon.stub(app['logger'], 'error');

      await expect(app.listen(3000)).to.be.rejectedWith(/EADDRINUSE/);
      expect(errorStub.called).to.be.true;

      errorStub.restore();
    });

    it('should keep autoListen disabled when options object omits enabled flag', async () => {
      const busyPorts = new Map<number, number>([[3000, 1]]);
      const { app } = createApplication({}, busyPorts);
      const errorStub = sinon.stub(app['logger'], 'error');

      await expect(app.listen(3000)).to.be.rejectedWith(/EADDRINUSE/);
      expect(errorStub.called).to.be.true;

      errorStub.restore();
    });
  });
});
