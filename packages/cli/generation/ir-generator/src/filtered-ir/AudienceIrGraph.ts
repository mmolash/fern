import { noop } from "@fern-api/core-utils";
import { ErrorDeclaration } from "@fern-fern/ir-model/errors";
import { DeclaredServiceName } from "@fern-fern/ir-model/services/commons";
import { HttpEndpoint } from "@fern-fern/ir-model/services/http";
import { ContainerType, DeclaredTypeName, TypeReference } from "@fern-fern/ir-model/types";
import { FilteredIr, FilteredIrImpl } from "./FilteredIr";
import {
    AudienceId,
    EndpointId,
    EndpointNode,
    ErrorId,
    ErrorNode,
    getEndpointId,
    getErrorId,
    getServiceId,
    getTypeId,
    ServiceId,
    TypeId,
    TypeNode,
} from "./ids";

export class AudienceIrGraph {
    private types: Record<TypeId, TypeNode> = {};
    private typesNeededForAudience: Set<TypeId> = new Set();
    private errors: Record<TypeId, ErrorNode> = {};
    private endpoints: Record<EndpointId, EndpointNode> = {};
    private servicesNeededForAudience: Set<ServiceId> = new Set();
    private endpointsNeededForAudience: Set<EndpointId> = new Set();
    private audiences: Set<AudienceId> = new Set();

    public constructor(audiences: AudienceId[]) {
        this.audiences = new Set(audiences);
    }

    public addType(declaredTypeName: DeclaredTypeName, descendants: DeclaredTypeName[]): void {
        const typeId = getTypeId(declaredTypeName);
        const typeNode: TypeNode = {
            typeId,
            descendants: new Set(...descendants.map((declaredTypeName) => getTypeId(declaredTypeName))),
        };
        this.types[typeId] = typeNode;
    }

    public markTypeForAudiences(declaredTypeName: DeclaredTypeName, audiences: string[]): void {
        const typeId = getTypeId(declaredTypeName);
        if (this.hasAudience(audiences)) {
            this.typesNeededForAudience.add(typeId);
        }
    }

    public addError(errorDeclaration: ErrorDeclaration): void {
        const errorId = getErrorId(errorDeclaration.name);
        const referencedTypes = new Set<TypeId>();
        if (errorDeclaration.typeV3 != null) {
            populateReferencesFromTypeReference(errorDeclaration.typeV3, referencedTypes);
        }
        const errorNode: ErrorNode = {
            errorId,
            referencedTypes,
        };
        this.errors[errorId] = errorNode;
    }

    public addEndpoint(declaredServiceName: DeclaredServiceName, httpEndpoint: HttpEndpoint): void {
        const endpointId = getEndpointId(declaredServiceName, httpEndpoint);
        const referencedTypes = new Set<TypeId>();
        const referencedErrors = new Set<ErrorId>();
        if (httpEndpoint.request.typeV2 != null) {
            populateReferencesFromTypeReference(httpEndpoint.request.typeV2, referencedTypes);
        }
        if (httpEndpoint.response.typeV2 != null) {
            populateReferencesFromTypeReference(httpEndpoint.response.typeV2, referencedTypes);
        }
        httpEndpoint.errors.forEach((responseError) => {
            referencedErrors.add(getErrorId(responseError.error));
        });
        this.endpoints[endpointId] = {
            endpointId,
            referencedTypes,
            referencedErrors,
        };
    }

    public markEndpointForAudience(
        declaredServiceName: DeclaredServiceName,
        httpEndpoints: HttpEndpoint[],
        audiences: AudienceId[]
    ): void {
        if (this.hasAudience(audiences)) {
            const serviceId = getServiceId(declaredServiceName);
            this.servicesNeededForAudience.add(serviceId);
            httpEndpoints.forEach((httpEndpoint) => {
                const endpointId = getEndpointId(declaredServiceName, httpEndpoint);
                this.endpointsNeededForAudience.add(endpointId);
            });
            this.servicesNeededForAudience.add(serviceId);
        }
    }

    public build(): FilteredIr {
        const typeIds = new Set<TypeId>();
        const errorIds = new Set<ErrorId>();
        for (const endpointId of this.endpointsNeededForAudience.keys()) {
            const endpointNode = this.getEndpointNode(endpointId);
            for (const errorId of endpointNode.referencedErrors) {
                if (errorIds.has(errorId)) {
                    continue;
                }
                errorIds.add(errorId);
                const errorNode = this.getErrorNode(errorId);
                this.addReferencedTypes(typeIds, errorNode.referencedTypes);
            }
            this.addReferencedTypes(typeIds, endpointNode.referencedTypes);
        }
        this.addReferencedTypes(typeIds, this.typesNeededForAudience);
        return new FilteredIrImpl({
            types: typeIds,
            errors: errorIds,
            services: this.servicesNeededForAudience,
            endpoints: this.endpointsNeededForAudience,
        });
    }

    private addReferencedTypes(types: Set<TypeId>, typesToAdd: Set<TypeId>): void {
        for (const typeId of typesToAdd.keys()) {
            if (types.has(typeId)) {
                continue;
            }
            types.add(typeId);
            const typeNode = this.getTypeNode(typeId);
            typeNode.descendants.forEach((descendantTypeId) => {
                types.add(descendantTypeId);
            });
        }
    }

    private getTypeNode(typeId: TypeId): TypeNode {
        const typeNode = this.types[typeId];
        if (typeNode == null) {
            throw new Error(`Failed to find type node with id ${typeId}`);
        }
        return typeNode;
    }

    private getErrorNode(errorId: ErrorId): ErrorNode {
        const errorNode = this.errors[errorId];
        if (errorNode == null) {
            throw new Error(`Failed to find error node with id ${errorId}`);
        }
        return errorNode;
    }

    private getEndpointNode(endpointId: EndpointId): EndpointNode {
        const endpointNode = this.endpoints[endpointId];
        if (endpointNode == null) {
            throw new Error(`Failed to find endpoint node with id ${endpointId}`);
        }
        return endpointNode;
    }

    private hasAudience(audiences: AudienceId[]): boolean {
        return audiences.some((audienceId) => this.audiences.has(audienceId));
    }
}

function populateReferencesFromTypeReference(typeReference: TypeReference, referencedTypes: Set<TypeId>) {
    TypeReference._visit(typeReference, {
        container: (containerType) => {
            populateReferencesFromContainer(containerType, referencedTypes);
        },
        named: (declaredTypeName) => {
            referencedTypes.add(getTypeId(declaredTypeName));
        },
        primitive: noop,
        unknown: noop,
        void: noop,
        _unknown: noop,
    });
}

function populateReferencesFromContainer(containerType: ContainerType, referencedTypes: Set<TypeId>) {
    ContainerType._visit(containerType, {
        list: (listType) => {
            populateReferencesFromTypeReference(listType, referencedTypes);
        },
        map: (mapType) => {
            populateReferencesFromTypeReference(mapType.keyType, referencedTypes);
            populateReferencesFromTypeReference(mapType.valueType, referencedTypes);
        },
        optional: (optionalType) => {
            populateReferencesFromTypeReference(optionalType, referencedTypes);
        },
        set: (setType) => {
            populateReferencesFromTypeReference(setType, referencedTypes);
        },
        literal: noop,
        _unknown: noop,
    });
}